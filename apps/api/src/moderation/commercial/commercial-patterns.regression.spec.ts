import type { ChatSettings } from '../../prisma/prisma-client';
import type { CommercialCampaignContext } from '../commercial-campaign.util';
import { createRuleDetectionContext } from '../rule-engine-detection-context';
import { resolveCommercialThresholds } from '../rule-engine-commercial-thresholds';
import { CommercialAdDetector } from './commercial-ad.detector';
import { collectCommercialSignals } from './commercial-features';
import { normalizeCommercialRawText, normalizeCommercialText } from './commercial-normalization';
import {
  ADS_ADVANCE_AIRPORT_STATION_TRANSFER_PATTERN,
  ADS_PROFESSIONAL_PASSENGER_PARCEL_TRANSFER_PATTERN,
  ADS_SCHEDULED_PASSENGER_PARCEL_ROUTE_PATTERN,
  ADS_SCHEDULED_ROUND_TRIP_DOOR_TO_DOOR_PATTERN,
  ADS_SCHEDULED_ROUND_TRIP_PARCEL_ROUTE_PATTERN,
  ADS_TAXIING_CONTACT_SELF_OFFER_PATTERN,
} from './commercial-patterns';

const BASE_SETTINGS = {
  commercialAdsFilterEnabled: true,
  commercialAdsSensitivity: 'STRICT',
  commercialAdsWarnThreshold: 38,
  commercialAdsDeleteThreshold: 55,
} as unknown as ChatSettings;

const detector = new CommercialAdDetector();

const REPEATED_PRIVATE_RESALE_CONTEXT: CommercialCampaignContext = {
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

function detect(
  text: string,
  options: {
    commercialCampaignContext?: CommercialCampaignContext | null;
    settings?: Partial<ChatSettings>;
  } = {},
) {
  const settings = {
    ...BASE_SETTINGS,
    ...options.settings,
  } as ChatSettings;
  const context = createRuleDetectionContext({
    text,
    settings,
  });

  return detector.detect({
    normalizedText: context.normalizedText,
    rawLoweredText: context.rawLoweredText,
    settings,
    commercialCampaignContext: options.commercialCampaignContext,
  });
}

function collectSignals(text: string) {
  const rawLoweredText = normalizeCommercialRawText(text);
  return collectCommercialSignals({
    normalizedText: normalizeCommercialText(rawLoweredText),
    rawLoweredText,
    profile: resolveCommercialThresholds(BASE_SETTINGS),
  });
}

describe('commercial pattern regressions', () => {
  it('keeps a priced service offer when the seller disclaims unrelated furniture sales', () => {
    const offer =
      'Оказываем услуги по ремонту квартир под ключ. Замер бесплатно, цены от 1200 рублей. Звоните +7 000 000 00 00.';
    for (const text of [offer, offer + ' Мебель не продаём.']) {
      expect(detect(text)).toMatchObject({
        primarySubtype: 'SERVICES',
        actionable: true,
        messageDisposition: 'DELETE',
      });
    }
    expect(
      collectSignals('Отчет по каналу: ER24 12%, рекламный пост стоил 500р, размещение не продаём.')
        .negativeSignals,
    ).toContain('context:channel-metrics-not-selling');
  });

  it.each([
    {
      label: 'accounting subscription service',
      text: 'Бухгалтер для ИП и ООО. Отчётность, декларации, налоги, кадровый учет. Абонентское обслуживание от 3000 руб. +7 900 000 00 92.',
      subtype: 'SERVICES',
      signals: ['service-specialty:accounting-service', 'transaction:price', 'contact:phone'],
    },
    {
      label: 'yandex direct contextual ads service',
      text: 'Настрою Яндекс Директ и контекстную рекламу. Аудит бесплатно, заявки уже через неделю. Пишите https://max.ru/u/directolog',
      subtype: 'SERVICES',
      signals: [
        'service-specialty:digital-service',
        'service-specialty:promotion-service',
        'deal-channel:link',
      ],
    },
    {
      label: 'medical center service',
      text: 'Медицинский центр: УЗИ, анализы, прием терапевта и невролога. Скидка 15%, запись +7 900 000 00 93.',
      subtype: 'SERVICES',
      signals: ['service-specialty:medical-service', 'promo:скидк', 'contact:phone'],
    },
    {
      label: 'rehabilitation center from sixteen hour audit miss',
      text: 'Реабилитационный центр Birlik основан на миннесотской 12 шаговой программе. Гештальт терапия, арт терапия, групповая терапия, индивидуальная терапия. Мы готовы помочь, помощь анонимна. Телефон +7 900 000 02 21.',
      subtype: 'SERVICES',
      signals: ['service-specialty:rehab-center-service', 'contact:phone'],
    },
    {
      label: 'scrap metal buyout',
      text: 'Приём металлолома, цветной и черный металл. Расчет сразу, выезд, звоните +7 900 000 00 94.',
      subtype: 'BUYOUT',
      signals: ['buyout:scrap-metal-buyout', 'contact:phone'],
    },
    {
      label: 'truck spare parts retail from fourteen hour audit miss',
      text: 'Продам запчасти грузовые. Рессоры FAW J6, амортизаторы, бортовые, генератор, стартер. Новые, цена от 5000 руб. Телефон +7 900 000 00 95.',
      subtype: 'GOODS_RETAIL',
      signals: ['intent:продам', 'goods-retail:auto-parts-retail', 'contact:phone'],
    },
    {
      label: 'multi object residential showcase from fourteen hour audit miss',
      text: 'ЖК Флора. Студия 24 м2 цена 3.450.000, квартира 32 м2 цена 4.250.000, студия 28 м2 цена 3.900.000. Звоните +7 900 000 00 96.',
      subtype: 'PROPERTY_AGENT',
      signals: ['property-agent:витрина-объектов-прайс', 'contact:phone'],
      negativeSignals: ['private:property-sale'],
    },
    {
      label: 'bath tub retail stays retail instead of recruitment',
      text: 'Банный чан из нержавеющей стали. Цена за полный комплект, доставка, гарантия. Телефон +7 900 000 00 97.',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:bath-tub-retail', 'contact:phone'],
    },
    {
      label: 'electromontage service with procurement wording stays service',
      text: 'Все виды электромонтажных работ, помощь закупки материалов, розетки, автоматы, щитки. Телефон +7 900 000 00 98.',
      subtype: 'SERVICES',
      signals: ['service-specialty:электромонтаж', 'contact:phone'],
    },
    {
      label: 'livestock procurement stays buyout after generic zakup tightening',
      text: 'Закуп КРС и МРС: коровы, быки, телята, овцы. Расчет сразу, выезд по району. Телефон +7 900 000 00 99.',
      subtype: 'BUYOUT',
      signals: ['buyout:livestock-procurement', 'contact:phone'],
    },
    {
      label: 'speech therapy launch from twelve hour audit miss',
      text: 'Запуск речи у неговорящих или малоговорящих детей. Ваш ребёнок заговорит уверенно с помощью профессионального логопеда! Индивидуальные занятия помогут развить речь быстро и эффективно. Запишитесь сегодня по номеру +7 900 000 01 00, действуют скидки.',
      subtype: 'SERVICES',
      signals: ['service-specialty:speech-therapy-lessons', 'contact:phone'],
    },
    {
      label: 'crane beam installation from twelve hour audit miss',
      text: 'Производство и монтаж кран балок под ключ. +7 900 000 01 02',
      subtype: 'SERVICES',
      signals: ['intent:crane-beam-under-key', 'service-specialty:crane-beam-installation'],
    },
    {
      label: 'pvc window and door maintenance from twelve hour audit miss',
      text: 'Ремонт и обслуживание окон и дверей из ПВХ, ремонт и обслуживание деревянных евроокон. Телефон +7 900 000 01 03.',
      subtype: 'SERVICES',
      signals: ['intent:window-door-maintenance', 'service-specialty:pvc-window-door-repair'],
    },
    {
      label: 'custom portrait order from twelve hour audit miss',
      text: 'Портрет на холсте - это подарок, который хранит воспоминания. Для заказа пишите именно на этот номер: +7 900 000 01 04 WA, Max.',
      subtype: 'SERVICES',
      signals: ['intent:custom-art-order', 'service-specialty:custom-art-order'],
    },
    {
      label: 'custom wood portrait service from post deploy sixteen hour audit miss',
      text: 'Портрет на дереве. Ваши фото на дереве, заготовки, подарите близким. Заказывают по телефону +7 900 000 02 06.',
      subtype: 'SERVICES',
      signals: ['intent:custom-art-order', 'service-specialty:custom-art-order', 'contact:phone'],
    },
    {
      label: 'home goods order with emoji phone from twelve hour audit miss',
      text: 'Переходите в нашу группу, где вы найдете посуду, технику и текстиль по самым низким ценам. По поводу заказа пишите по номеру 8️⃣9️⃣8️⃣9️⃣8️⃣8️⃣8️⃣2️⃣0️⃣8️⃣9️⃣',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:home-goods-low-price-order', 'contact:phone'],
    },
    {
      label: 'remote manager recruitment is not moderation discussion',
      text: 'Ищу сотрудников для работы удаленно. Управляющий/админ для сопровождения интернет магазина. Работа с рекламой, обработка входящих откликов. Подробнее пишите в Телеграмм или МАХ +7 900 000 01 05. #вакансия #работаонлайн https://max.ru/join/remote-work',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:ваканси', 'recruitment:отклик', 'contact:phone'],
    },
    {
      label: 'job-seeking hook with vacancy offer is still recruitment',
      text: 'Нужна работа? Вакансия удаленно, доход от 3000 в день, пишите в MAX https://max.ru/join/work',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:ваканси', 'recruitment:доход', 'deal-channel:link'],
      negativeSignals: ['job-seeking:job-seeking:search'],
    },
    {
      label: 'remote recruitment with roughly wording is not quoted-ad discussion',
      text: 'Открыта вакансия удаленной работы. Нужен менеджер по работе с холодной/теплой базой. Зп 17000 в месяц. Примерно час работы в день. Пишите на мой личный +7 900 000 01 06 Мах или вотсап.',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:ваканси', 'recruitment:remote-network-work', 'contact:phone'],
    },
    {
      label: 'hotel tour booking with examples wording',
      text: 'Обзор сетей отелей Voyage в Турции. Примеры туров на двоих с вылетом из Сочи - по ссылкам в MAX и Telegram. Подберу под ваши даты и город вылета. Забронировать: +7 900 000 01 07 @travelmax https://max.ru/join/tour',
      subtype: 'SERVICES',
      signals: ['service-specialty:tour-agency', 'contact:phone', 'deal-channel:link'],
    },
    {
      label: 'fish processing crew recruitment from sixteen hour audit miss',
      text: 'Требуются люди на добычу и переработку горбуши. Пишите, звоните по телефону +7 900 000 01 11.',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:people-work-conditions', 'contact:phone'],
    },
    {
      label: 'no investment remote work from sixteen hour audit miss',
      text: 'ИЩУ ЛЮДЕЙ ДЛЯ РАБОТЫ БЕЗ ВЛОЖЕНИЙ. Выплаты ежедневно от 5000. https://max.ru/join/work',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:people-work-conditions', 'recruitment:remote-network-work'],
    },
    {
      label: 'bank project staff recruitment from sixteen hour audit miss',
      text: 'В банковский проект набираются сотрудники. Зп от 15-35 тыс. Телефон +7 900 000 01 12.',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:people-work-conditions', 'contact:phone'],
    },
    {
      label: 'online lottery bonus from sixteen hour audit miss',
      text: 'Выигрыш до 10 000 ₽ в онлайн-лотерее. Стартовый баланс, играете и выигрываете. https://max.ru/join/game',
      subtype: 'GOODS',
      signals: ['risk:online-lottery-bonus', 'deal-channel:link'],
    },
    {
      label: 'clairvoyant paid service from sixteen hour audit miss',
      text: 'Опытная ясновидящая, делаю диагностику ситуации, предсказываю. Связаться Max WhatsApp Telegram.',
      subtype: 'SERVICES',
      signals: [
        'risk:paid-esoteric-service',
        'service-specialty:divination-self-offer',
        'contact:whatsapp',
        'contact:telegram',
      ],
    },
    {
      label: 'photo restoration digital service from sixteen hour audit miss',
      text: 'Восстановление старых ч/б фото в цвете онлайн. 150 р. за 1 фото. +7 900 000 01 13.',
      subtype: 'SERVICES',
      signals: ['service-specialty:digital-service', 'contact:phone'],
    },
    {
      label: 'mosquito net installation from sixteen hour audit miss',
      text: 'МОСКИТНЫЕ СЕТКИ. Замеры, Изготовление, Установка. Пишите в ЛС.',
      subtype: 'SERVICES',
      signals: ['service-specialty:mosquito-net-service', 'contact:пишите в лс'],
    },
    {
      label: 'fence and gate installation from sixteen hour audit miss',
      text: 'Установим забор и ворота, монтаж откатных ворот. Бесплатно проконсультирую. +7 900 000 01 14.',
      subtype: 'SERVICES',
      signals: ['intent:fence-gate-installation', 'contact:phone'],
    },
    {
      label: 'clothing repair service from sixteen hour audit miss',
      text: 'Ремонт одежды. тел. +7 900 000 01 15.',
      subtype: 'SERVICES',
      signals: ['service-specialty:clothing-repair-service', 'contact:phone'],
    },
    {
      label: 'custom address signs from sixteen hour audit miss',
      text: 'Принимаем заявки на адресные таблички. Магазин Три кота.',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:custom-sign-order', 'transaction:keywords'],
    },
    {
      label: 'realtor commission rental from sixteen hour audit miss',
      text: 'Сдам однокомнатную квартиру. Риэлторская комиссия оплачивается по факту заселения. +7 900 000 01 16.',
      subtype: 'PROPERTY_AGENT',
      signals: ['property-agent:риэлторская-комиссия', 'contact:phone'],
      negativeSignals: ['private:property-sale'],
    },
    {
      label: 'rental commission percent from sixteen hour audit miss',
      text: 'Аренда дома. Цена:35000 Без залога Комиссия 60% Тел +7 900 000 01 17.',
      subtype: 'PROPERTY_AGENT',
      signals: ['property-agent:комиссия-процент', 'contact:phone'],
      negativeSignals: ['private:property-sale'],
    },
    {
      label: 'strawberry order from sixteen hour audit miss',
      text: 'Принимаю заказ на клубничку. Цена 250 руб килограмм. Бесплатная доставочка. +7 900 000 01 18.',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:wholesale-produce', 'contact:phone'],
    },
    {
      label: 'laying hens retail from sixteen hour audit miss',
      text: 'В продаже куры несушки. Цена 500р. от 10шт бесплатная доставка. +7 900 000 01 19.',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:farm-livestock-retail', 'contact:phone'],
    },
    {
      label: 'fresh trout delivery from sixteen hour audit miss',
      text: 'Свежий привоз. Форель Турция. Цена 1450 -1 кг. писать в личку или по телефону +7 900 000 01 20.',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:wholesale-produce', 'goods-retail:home-food-order'],
    },
    {
      label: 'stewed beef jar delivery from sixteen hour audit miss',
      text: 'Тушёная говядина 320 баночка от пяти баночек доставкой бесплатно.',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:home-food-order', 'transaction:keywords'],
    },
    {
      label: 'peony shipping retail from sixteen hour audit miss',
      text: 'ПИОНЫ. СНАЧАЛА ОПЛАТА ПОТОМ ОТПРАВКА. по 950р. доставка. +7 900 000 01 21.',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:plant-nursery-stock', 'goods-retail:plant-nursery-shipping'],
    },
    {
      label: 'paid group mailing with emoji keycap prices from sixteen hour audit miss',
      text: '3️⃣ дня рассылка 8️⃣6️⃣0️⃣Р. 5️⃣0️⃣0️⃣ групп MAX, база групп, фото/видео отчет. Пишите в личку https://example.com/max-mailing',
      subtype: 'SERVICES',
      signals: ['risk:paid-group-mailing', 'transaction:price', 'deal-channel:link'],
    },
    {
      label: 'leaflet assembly work with spaced role from sixteen hour audit miss',
      text: 'С Б О Р Щ И К упаковка листовок. Оплата 1️⃣0️⃣ 0️⃣0️⃣0️⃣ руб, график свободный, телефон +7 900 000 02 01',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:leaflet-assembly-work', 'transaction:price', 'contact:phone'],
    },
    {
      label: 'short daily leaflet side job from post deploy sixteen hour audit miss',
      text: 'ПОДРАБОТКА каждый день — раздача листовок',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:leaflet-daily-side-job', 'contact:implicit-vacancy-offer'],
    },
    {
      label: 'wb helper vacancy from sixteen hour audit miss',
      text: 'Срочно требуется помощник для работы с WB. В день от 4500 р, без опыта, подробности https://example.com/wb-job',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:требуется', 'transaction:price', 'deal-channel:link'],
    },
    {
      label: 'legal document services from sixteen hour audit miss',
      text: 'Юридические услуги: подготовка исковых заявлений, претензий и жалоб, представительство в суде. Телефон +7 900 000 02 02',
      subtype: 'SERVICES',
      signals: ['service-specialty:legal-document-service', 'contact:phone'],
    },
    {
      label: 'collectible violet retail from sixteen hour audit miss',
      text: 'Коллекционные фиалки, детки и стартеры, список сортов. Минимальный заказ, упаковка, отправка СДЭК и почтой. 150 руб, ватсап +7 900 000 02 04',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:collectible-flower-retail', 'transaction:price', 'contact:phone'],
    },
    {
      label: 'developer house with implied million price from sixteen hour audit miss',
      text: 'Дом от застройщика в новом поселке. Подходит под семейную ипотеку, стоимость 8.5 млн, отделка, телефон +7 900 000 02 05',
      subtype: 'PROPERTY_AGENT',
      signals: ['property-agent:дом-от-застройщика', 'transaction:implied-price', 'contact:phone'],
    },
    {
      label: 'generic domain service promo from blind spot sweep',
      text: 'Новый сервис доставки еды, скидка по промокоду START. Переходите example-food.ru/menu, заказ онлайн',
      subtype: 'GOODS',
      signals: ['promo:промокод', 'deal-channel:generic-domain'],
    },
    {
      label: 'service marketplace link from blind spot sweep',
      text: 'Ремонт холодильников на дому, диагностика бесплатно, гарантия. Запись тут avito.ru/services/remont-holodilnikov',
      subtype: 'SERVICES',
      signals: ['service-specialty:appliance-repair', 'deal-channel:marketplace-service-link'],
    },
    {
      label: 'email contact service from blind spot sweep',
      text: 'Бухгалтерское сопровождение ИП и ООО, отчетность и декларации. Заявки на почту buh-office@example.com',
      subtype: 'SERVICES',
      signals: ['service-specialty:accounting-service', 'contact:email'],
    },
    {
      label: 'soft response cta service from blind spot sweep',
      text: 'Ресницы, брови, ламинирование. Свободные окошки завтра, кто хочет - ставьте плюс',
      subtype: 'SERVICES',
      signals: ['service-specialty:ресниц', 'contact:soft-response-cta'],
    },
    {
      label: 'government benefit phishing from blind spot sweep',
      text: 'Получите выплату 10000 через госуслуги, заполните анкету по ссылке clck.ru/abc123',
      subtype: 'GOODS',
      signals: ['risk:government-benefit-phishing', 'deal-channel:link'],
    },
    {
      label: 'wireless internet service from forty eight hour audit miss',
      text: 'БЕСПРОВОДНОЙ ИНТЕРНЕТ В ЧАСТНЫЙ ДОМ! Скорость до 200 мегабит. Тел.: +7 900 000 03 01. Объявление.',
      subtype: 'SERVICES',
      signals: ['service-specialty:internet-connection-service', 'contact:phone'],
    },
    {
      label: 'addiction detox service from forty eight hour audit miss',
      text: 'Отравление, похмелье. Вывод из запоя, кодировка, снятие ломки, реабилитация. Помощь анонимна, телефон +7 900 000 03 02.',
      subtype: 'SERVICES',
      signals: ['service-specialty:addiction-detox-service', 'contact:phone'],
    },
    {
      label: 'telecom connection services from forty eight hour audit miss',
      text: 'Подключение услуг РОСТЕЛЕКОМ: Интернет, Wink, видеонаблюдение, мобильная связь. Прием заявок по телефону +7 900 000 03 03. Реклама.',
      subtype: 'SERVICES',
      signals: ['service-specialty:internet-connection-service', 'contact:phone'],
    },
    {
      label: 'story channel subscription from forty eight hour audit miss',
      text: 'ДУШЕВНЫЕ ИСТОРИИ НА ВЕЧЕР. Рекомендуем Вам подписаться на канал, переходите по ссылке https://max.ru/join/story',
      subtype: 'CHANNEL_PLACEMENT',
      signals: ['channel-placement:subscribe-channel-link', 'deal-channel:link'],
    },
    {
      label: 'free sports giveaway channel from forty eight hour audit miss',
      text: 'ВНИМАНИЕ! РОЗЫГРЫШ 50.000 РУБЛЕЙ ЗА ПОДПИСКУ В КАНАЛ. Автор зарабатывает на спорте, ссылка https://max.ru/join/sport',
      subtype: 'CHANNEL_PLACEMENT',
      signals: [
        'business:promotional-giveaway',
        'channel-placement:subscribe-channel-link',
        'deal-channel:link',
      ],
    },
    {
      label: 'science channel direct-link teaser from twenty four hour corpus',
      text: 'Это лишь малая часть удивительных фактов. Еще больше необычного о человеке, космосе и природе - в канале "Наука и факты". ССЫЛКА НА КАНАЛ [url]',
      subtype: 'CHANNEL_PLACEMENT',
      signals: ['channel-placement:subscribe-channel-link'],
    },
    {
      label: 'marketplace channel private-link invitation from twenty four hour corpus',
      text: 'Присоединяйтесь к нам в канал за ссылкой в личные сообщения. Там много товаров с маркетплейсов по низким ценам.',
      subtype: 'CHANNEL_PLACEMENT',
      signals: ['channel-placement:subscribe-channel-link'],
    },
    {
      label: 'emoji-separated giveaway channel invitation from twenty four hour corpus',
      text: 'ДАРИТ 50.000 РУБЛЕЙ ЗА ОДНУ ПОДПИСКУ В КАНАЛ! Как забрать деньги? Вступай в канал по ссылке - подписка автоматически делает тебя участником. Наблюдай за постами и жди результаты. [url]',
      subtype: 'CHANNEL_PLACEMENT',
      signals: ['channel-placement:subscribe-channel-link'],
    },
    {
      label: 'ai fitting app promo from forty eight hour audit miss',
      text: 'Попробуй Кадрум — AI-примерку одежды, крутые нейро-фотосессии и фото для профиля. Ссылка kadrum.ai',
      subtype: 'GOODS',
      signals: ['business:ai-media-app-promo', 'deal-channel:generic-domain'],
    },
    {
      label: 'obfuscated casino landing from agent blind spot',
      text: 'К а з и н о win4land точка com, бонус за регистрацию и быстрый депозит.',
      subtype: 'GOODS',
      signals: ['risk:betting-gambling'],
    },
    {
      label: 'electronics buyout without explicit phone from agent blind spot',
      text: 'Куплю ноутбуки и айфоны в любом состоянии. Оценка сразу, выезд к вам, расчет наличными.',
      subtype: 'BUYOUT',
      signals: ['buyout:used-electronics-buyout', 'transaction:buyout-deal'],
    },
    {
      label: 'property lead magnet from agent blind spot',
      text: 'Бесплатный подбор новостроек. Квартиры от застройщика без комиссии, оставьте заявку на сайте novostroy-example.ru',
      subtype: 'PROPERTY_AGENT',
      signals: ['property-agent:новостройки-лидоген', 'deal-channel:generic-domain'],
    },
    {
      label: 'crypto investment stays high risk instead of recruitment',
      text: 'Крипто-сигналы: пассивный доход, разбор портфеля и закрытый канал. Пишите https://max.ru/join/crypto',
      subtype: 'GOODS',
      signals: ['risk:crypto-investment', 'deal-channel:link'],
    },
    {
      label: 'loan leadgen with mixed-script salary wording',
      text: 'Дeньги дo зapплaты oнлaйн, oдoбpeниe 15 минут, без отказа. Ccылкa в профиле.',
      subtype: 'GOODS',
      signals: ['risk:loan-leadgen', 'transaction:high-risk-offer', 'contact:ссылка в профиле'],
    },
    {
      label: 'p2p crypto arbitrage training leadgen',
      text: 'P2P арбитраж: связки каждый день, депозит от 5000, обучение в закрытом чате, вход по инвайту.',
      subtype: 'INFO_PRODUCT',
      signals: ['risk:p2p-crypto-arbitrage', 'transaction:high-risk-offer'],
    },
    {
      label: 'p2p crypto arbitrage invite-only chat without explicit contact',
      text: 'P2P связки каждый день, закрытый чат, вход по инвайту.',
      subtype: 'GOODS',
      signals: ['risk:p2p-crypto-arbitrage', 'transaction:high-risk-offer'],
    },
    {
      label: 'credit history leadgen with comments response',
      text: 'Кредитная история испорчена? Поможем получить деньги быстро, ответ в комментариях.',
      subtype: 'GOODS',
      signals: ['risk:loan-leadgen', 'transaction:high-risk-offer', 'contact:comments-response'],
    },
    {
      label: 'payment card drop leadgen',
      text: 'Нужны карты для приема переводов, без визита, оплата ежедневно, пишите в тг cashwork77.',
      subtype: 'GOODS',
      signals: ['risk:payment-card-drop-leadgen', 'contact:handle'],
    },
    {
      label: 'iphone repair service with casual wording',
      text: 'Чиню айфоны, меняю стекла и батареи, выезд по городу. Писать в лс.',
      subtype: 'SERVICES',
      signals: ['service-specialty:digital-service', 'contact:в лс'],
    },
    {
      label: 'pet grooming appointment service',
      text: 'Груминг собак и кошек, стрижка когтей, вычес, купание. Принимаю по записи, свободно завтра.',
      subtype: 'SERVICES',
      signals: ['service-specialty:pet-grooming-service', 'contact:по записи'],
    },
    {
      label: 'kids event animator service',
      text: 'Аниматоры на детский праздник, шоу мыльных пузырей, аквагрим. Бронируйте дату, пишите в личку.',
      subtype: 'SERVICES',
      signals: ['service-specialty:kids-event-service', 'contact:пишите в лич'],
    },
    {
      label: 'channel ad window placement slang',
      text: 'Свободные окна в кaнaлe, 24ч топ, охват живой. Статa скину, место 700р, связь @adm_rek',
      subtype: 'CHANNEL_PLACEMENT',
      signals: ['channel-placement:ad-window-top', 'transaction:price', 'contact:handle'],
    },
    {
      label: 'info product registration through form',
      text: 'Марафон по отношениям 7 дней, практики и эфиры, места ограничены, регистрация через анкету.',
      subtype: 'INFO_PRODUCT',
      signals: ['info:марафон', 'transaction:keywords'],
    },
    {
      label: 'short stay apartment booking',
      text: 'Апартаменты у моря свободны с 12 июля. До пляжа 5 минут, бронь по предоплате, календарь в личку.',
      subtype: 'PROPERTY_AGENT',
      signals: ['property-agent:посуточная-бронь-апартаментов', 'transaction:keywords'],
    },
    {
      label: 'electrical wiring service from twenty four hour audit miss',
      text: 'Замена проводки в квартире, в доме. Сборка щитов. Работы на линиях электропередачи -кВ. Выполнение устройства заземления. ☎️Тел +7 900 000 10 01.',
      subtype: 'SERVICES',
      signals: ['service-specialty:electrical-wiring-service', 'contact:phone'],
    },
    {
      label: 'ready business sale reverse price order from twenty four hour audit miss',
      text: 'Так же продается бизнес за 100000 в Саянске, готовый. Писать +7 900 000 10 02',
      subtype: 'GOODS',
      signals: ['business:business-sale', 'contact:phone'],
    },
    {
      label: 'short collectible flower retail from twenty four hour audit miss',
      text: 'Сортовые фиалки по вопросам в личку',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:collectible-flower-retail'],
    },
    {
      label: 'short flowers with unit price and phone from twenty four hour audit miss',
      text: 'Продам цветы по 15 р шт. Кинель юг +7 900 000 10 41',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:flower-herb-unit-price-retail', 'transaction:price', 'contact:phone'],
    },
    {
      label: 'short herb unit price from twenty four hour audit miss',
      text: 'Душица лист - 90руб/мешочек',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:flower-herb-unit-price-retail', 'transaction:price'],
    },
    {
      label: 'short cargo service with phone from post deploy audit miss',
      text: 'ГРУЗОПЕРЕВОЗКИ +7 900 000 10 42',
      subtype: 'SERVICES',
      signals: [
        'service-specialty:грузоперевоз',
        'service-specialty:logistics-delivery',
        'contact:phone',
      ],
    },
    {
      label: 'beauty salon phone service from post deploy audit miss',
      text: 'Приглашаю тебя красотка! На окрашивание, окудрение, флисинг, карвинг, реконструкцию волос. Я жду тебя по адресу Титова 238 салон Корона или пиши/звони +7 900 000 10 43 Наталья',
      subtype: 'SERVICES',
      signals: ['service-specialty:beauty-salon-service', 'contact:phone'],
    },
    {
      label: 'handmade self channel promo without visible link from post deploy audit miss',
      text: 'Всем привет) Добро пожаловать в мой Мир страз Юлии. Уникальные и индивидуальные изделия ручной работы от магнитов и футболок, до инкрустации любой вещи. До 1 июля можно забрать портрет из страз со скидкой в 50%. Всего 3 портрета, может это твой? Буду рада всем в своем блестящем мире. МОЙ КАНАЛ',
      subtype: 'CHANNEL_PLACEMENT',
      signals: [
        'promo:скидк',
        'channel-placement:handmade-self-channel-promo',
        'transaction:handmade-channel-offer',
      ],
      negativeSignals: ['context:question'],
    },
    {
      label: 'vehicle advertising placement from twenty four hour audit miss',
      text: 'Разместим вашу рекламу на наших авто +7 900 000 10 03',
      subtype: 'SERVICES',
      signals: ['service-specialty:vehicle-ad-placement', 'contact:phone'],
    },
    {
      label: 'uzbek mixed wildberries warehouse recruitment from twenty four hour audit miss',
      text: 'WILDBERRIES МОСКОВСКАЯ ОБЛАСТЬ. Бепул яшаш жой! ТРУДОВОЙ ДОГОВОР. Сортировка товара 4000₽, ойлик маош. ТУЛИК ДОКУМЕНТ БИЛАН ИШГА ОЛАМИЗ! Мурожаат учун: Телеграм/max/ прямой. +7 900 000 10 04',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:warehouse-job-conditions', 'contact:phone'],
    },
    {
      label: 'door retail discount from twenty four hour audit miss',
      text: 'ВНИМАНИЕ! Снижение цен на все металлические и межкомнатные двери. Двери с терморазрывом от 27000 руб! Рассрочка на все без %, тел. +7 900 000 10 05',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:door-window-retail-discount', 'transaction:price'],
    },
    {
      label: 'custom song service from twenty four hour audit miss',
      text: 'Делаю полноценные песни по вашим идеям. Цена вопроса - 1000₽. Чтобы начать, просто напиши мне в личку.',
      subtype: 'SERVICES',
      signals: ['service-specialty:custom-song-service', 'transaction:price'],
    },
    {
      label: 'stretch ceiling service from twenty four hour audit miss',
      text: 'НАТЯЖНЫЕ ПОТОЛКИ -20% пенсионерам. Замер бесплатный, звони по номеру +7 900 000 10 06',
      subtype: 'SERVICES',
      signals: ['service-specialty:stretch-ceiling-service', 'contact:phone'],
    },
    {
      label: 'wood outbuilding retail from twenty four hour audit miss',
      text: 'Предлагаем вашему вниманию изделия из сухого пиломатериала: хоз блоки, беседки, уличные туалеты. Находимся в п. Центральный, ул. Промышленная 41. +7 900 000 10 07',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:wood-outbuilding-retail', 'contact:phone'],
    },
    {
      label: 'mortgage studio promo from twenty four hour audit miss',
      text: 'Ремонт в подарок + ставка 4,5%. Студия 30,44 м² уже с ремонтом. Первоначальный взнос 400 000 ₽. Напишите СТУДИЯ, рассчитаем под вас. +7 900 000 10 08',
      subtype: 'PROPERTY_AGENT',
      signals: ['property-agent:mortgage-studio-promo', 'contact:phone'],
      negativeSignals: ['private:property-sale'],
    },
    {
      label: 'septic and excavator service from twenty four hour audit miss',
      text: 'ВЫГРЕБНЫЕ ЯМЫ ПОД КЛЮЧ, УСЛУГИ МИНИ ЭКСКАВАТОРА И САМОСВАЛА +7 900 000 10 09',
      subtype: 'SERVICES',
      signals: ['service-specialty:septic-excavator-service', 'contact:phone'],
    },
    {
      label: 'multi role shift pay recruitment from twenty four hour audit miss',
      text: 'На постоянную работу в кафе требуется уборщица: график 6/1, 3800р. за смену. Дворник: график 6/1, 3600р. за смену. +7 900 000 10 10',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:роль-условия', 'contact:phone'],
    },
    {
      label: 'driver park payout recruitment from twenty four hour audit miss',
      text: 'Парк где не требуется самозанятость. 24/7 поддержка. Моментальная выплата средств. +7 900 000 10 11',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:driver-park-payout-work', 'contact:phone'],
    },
    {
      label: 'agent commission townhouse from twenty four hour audit miss',
      text: 'КП АВСТРИЯ. ТАУНХАУС 130 кв.м. Лучшая цена 14 000 000₽. Комиссия агентам 250000₽ в цене. +7 900 000 10 12',
      subtype: 'PROPERTY_AGENT',
      signals: ['property-agent:комиссия-агентам', 'contact:phone'],
      negativeSignals: ['private:property-sale'],
    },
    {
      label: 'commercial property coffee shop lease boundary',
      text: 'Сдам место под кофейню 18 м² в проходном ТЦ, мокрая точка, витрина, 45000 в месяц. Звоните +7 900 000 11 01.',
      subtype: 'PROPERTY_COMMERCIAL',
      signals: ['property-commercial:commercial-space', 'contact:phone'],
    },
    {
      label: 'urgent damaged auto buyout with free tow',
      text: 'Срочно выкупим авто после ДТП без документов, деньги сразу, эвакуатор бесплатно. Пишите @auto_cash.',
      subtype: 'BUYOUT',
      signals: ['buyout:auto-same-day-buyout', 'transaction:buyout-deal', 'contact:handle'],
    },
    {
      label: 'short home dumplings order from agent recall sweep',
      text: 'Домашние пельмени 500р/кг, заказ @foodhome',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:home-food-order', 'transaction:price', 'contact:handle'],
    },
    {
      label: 'home dairy delivery from final prod audit false negative',
      text: 'Предлагаю козье молоко, творог, йогурт, сыры. Доставим до вашего подъезда . т 89277172079',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:home-dairy-retail', 'contact:phone'],
    },
    {
      label: 'home dairy applications with delivery rounds',
      text: 'Домашняя молочка: сметана, творог, кефир, сыр. Развоз по пятницам, заявки в личку.',
      subtype: 'GOODS_RETAIL',
      signals: ['goods-retail:home-dairy-retail', 'contact:в личк'],
    },
    {
      label: 'euphemistic auto buyout with immediate settlement',
      text: 'Заберу авто в любом состоянии, расчет сразу на месте. Документы не проблема.',
      subtype: 'BUYOUT',
      signals: ['buyout:auto-same-day-buyout', 'transaction:buyout-deal'],
    },
    {
      label: 'euphemistic livestock procurement with immediate settlement',
      text: 'Приедем заберём коров и бычков, расчет на месте живым весом.',
      subtype: 'BUYOUT',
      signals: ['buyout:livestock-procurement', 'transaction:buyout-deal'],
    },
    {
      label: 'remote project recruitment with income but no contact',
      text: 'Нужны люди в проект. Доход от 7000 в день, без вложений, обучение.',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:people-work-conditions', 'transaction:implied-price'],
    },
    {
      label: 'paid group directory addition',
      text: 'Каталог групп района: 1. Чат мам https://max.ru/join/a 2. Работа https://max.ru/join/b 3. Услуги https://max.ru/join/c. Добавление платное.',
      subtype: 'CHANNEL_PLACEMENT',
      signals: ['channel-placement:paid-directory-addition', 'deal-channel:link'],
    },
    {
      label: 'agent rental commission to realtor from recall sweep',
      text: 'Сдам квартиру на длительный срок, комиссия риэлтору 50%, показ сегодня, телефон +7 900 000 11 02.',
      subtype: 'PROPERTY_AGENT',
      signals: ['property-agent:комиссия-агенту-аренда', 'contact:phone'],
      negativeSignals: ['private:property-sale'],
    },
    {
      label: 'short stay apartment booking from recall sweep',
      text: 'Квартира посуточно рядом с вокзалом, свободна на выходные, бронь в личку.',
      subtype: 'PROPERTY_AGENT',
      signals: ['property-agent:посуточная-квартира-бронь', 'contact:в личк'],
    },
    {
      label: 'paid social actions work from recall sweep',
      text: 'Ставь лайки, подписывайся и получай деньги на карту ежедневно, задания в личку.',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:paid-social-actions-work', 'contact:в личк'],
    },
    {
      label: 'chat correspondence operator from recall sweep',
      text: 'Оператор переписки в MAX, свободный график, выплаты каждую неделю, обучение, пишите.',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:chat-correspondence-operator'],
    },
    {
      label: 'vp op channel cross promo from recall sweep',
      text: 'ОП/ВП в MAX каналах, аудитория 12к, статистику скину в личку.',
      subtype: 'CHANNEL_PLACEMENT',
      signals: ['channel-placement:vp-op-cross-promo', 'contact:в личк'],
    },
    {
      label: 'paid chat pin placement from recall sweep',
      text: 'Закреп в чате на сутки 300р, оставляйте ссылку админу.',
      subtype: 'CHANNEL_PLACEMENT',
      signals: ['channel-placement:paid-pin-placement', 'transaction:price'],
    },
    {
      label: 'group promo through profile link',
      text: 'Наш чат для мам, заходите, ссылка в профиле.',
      subtype: 'GROUP_PROMOTION',
      signals: ['combo:group-promo+profile-contact', 'contact:ссылка в профиле'],
    },
    {
      label: 'short stay island lodging from agent recall sweep',
      text: 'Сдаю бюджетное жильё на Ольхоне: домики, душ, мангал. Телефон +7 900 000 10 20',
      subtype: 'PROPERTY_AGENT',
      signals: ['property-agent:short-stay-domiki-booking', 'contact:phone'],
    },
    {
      label: 'bare question sauna kit self promo from agent recall sweep',
      text: 'Хотите баню под ключ? Полная сборка, доставка отдельно, заказывайте готовое решение.',
      subtype: 'GOODS_RETAIL',
      signals: ['business:заказывайте', 'transaction:keywords', 'goods-retail:inventory'],
    },
    {
      label: 'short cabbage seedling clearance stock from twenty four hour audit miss',
      text: 'Продам остатки рассады белокочанной капусты : Надежда, Амагер, Московская поздняя, Грибовская.',
      subtype: 'GOODS_RETAIL',
      signals: [
        'intent:продам',
        'promo:остатк',
        'goods-retail:plant-nursery-clearance-stock',
        'transaction:clearance-stock',
      ],
    },
    {
      label: 'multi price seedling leftovers from post deploy audit miss',
      text: 'Продам остатки рассады томатов грунтовых 11 шт, цена 30 руб зашт, перцев красных, жёлтых, шоколадных, цена 20 руб за шт. Самовывоз Северск, Иглаково',
      subtype: 'GOODS_RETAIL',
      signals: [
        'intent:продам',
        'promo:остатк',
        'goods-retail:plant-nursery-stock',
        'transaction:price',
        'transaction:keywords',
      ],
      negativeSignals: ['private-goods:private-seedling-leftovers'],
    },
    {
      label: 'avito review side income from twenty four hour audit miss',
      text: 'Всем привет! Нам очень нужны отзывы на Авито. Отлично подойдет в качестве доп.заработка. Если кому-то актуально, пишите в личку.',
      subtype: 'RECRUITMENT',
      signals: ['recruitment:marketplace-review-work', 'contact:пишите в лич'],
    },
    {
      label: 'debt relief leadgen with profile application',
      text: 'Списание долгов через банкротство, консультация бесплатно, анкета для заявки в профиле.',
      subtype: 'SERVICES',
      signals: [
        'risk:debt-relief-service',
        'service-specialty:debt-relief-service',
        'transaction:high-risk-offer',
      ],
    },
    {
      label: 'paid marketplace review task with chat link',
      text: 'Нужно 20 человек для отзывов на Wildberries, оплата сразу после задания, ссылка на чат https://max.ru/join/reviews.',
      subtype: 'RECRUITMENT',
      signals: [
        'risk:paid-review-task',
        'recruitment:marketplace-review-work',
        'deal-channel:link',
      ],
    },
    {
      label: 'paid contest votes with task link',
      text: 'Платим за голос в конкурсе, 50 рублей за реакцию, ссылка на задание https://example.com/task',
      subtype: 'RECRUITMENT',
      signals: [
        'risk:paid-review-task',
        'transaction:high-risk-offer',
        'recruitment:paid-social-actions-work',
      ],
    },
    {
      label: 'paid survey referral with payout link',
      text: 'Опросы с оплатой до 500 рублей, вывод на карту, регистрация https://example.com/opros.',
      subtype: 'GOODS',
      signals: ['business:paid-survey-referral', 'transaction:price', 'deal-channel:link'],
    },
    {
      label: 'app directory promo with jobs and listings',
      text: 'Скачай приложение Работа и квартира: свежие вакансии, объявления и авто рядом, ссылка https://example.com/app.',
      subtype: 'RECRUITMENT',
      signals: ['risk:app-store-directory-promo', 'recruitment:ваканси', 'deal-channel:link'],
    },
    {
      label: 'bulk client leadgen with bot and warm base',
      text: 'Теплая база клиентов для мастеров красоты, заявки ежедневно, подключение через бот https://example.com/clients.',
      subtype: 'SERVICES',
      signals: ['risk:bulk-client-leadgen', 'service-specialty:marketing-automation'],
    },
    {
      label: 'paid channel ad placement with handle',
      text: 'Размещение рекламы в канале 1500р, статистика живая, заявки в личку @admin.',
      subtype: 'CHANNEL_PLACEMENT',
      signals: ['channel-placement:paid-group-promo', 'transaction:price', 'contact:handle'],
    },
  ])('detects $label', ({ text, subtype, signals, negativeSignals = [] }) => {
    const result = detect(text);

    expect(result).toBeDefined();
    expect(result?.primarySubtype).toBe(subtype);
    expect(result?.matchedSignals).toEqual(expect.arrayContaining(signals));
    expect(result?.negativeSignals).toEqual(negativeSignals);
  });

  it('keeps a question-framed structured beauty offer reviewable', () => {
    const result = detect(
      'Хотите гладкие волосы без ежедневной укладки? Кератиновое выпрямление и ботокс для волос. Стоимость процедуры рассчитывается индивидуально.',
    );

    expect(result?.primarySubtype).toBe('SERVICES');
    expect(result?.actionBand).toBe('REVIEW_ONLY');
    expect(result?.matchedSignals).toContain('service-specialty:beauty-procedure-benefit-offer');
    expect(result?.negativeSignals).toEqual(['context:question']);
  });

  it.each([
    [
      'window installation with a phone',
      'Пластиковые окна и двери. Холодно, шумно, сквозит? Пора менять! Энергосберегающие стеклопакеты, бесплатный замер. [phone]',
    ],
    [
      'stretch ceiling with a phone',
      'Натяжные потолки любой сложности. Вода с потолка? Не проблема. Бесплатный выезд и расчет, мастер со стажем более 10 лет. [phone]',
    ],
    [
      'massage booking call to action',
      'Хочешь улучшить осанку и убрать боли в спине? Записывайся на миофасциальный массаж уже сегодня!',
    ],
    [
      'tattoo removal response call to action',
      'Кто желает удалить старый татуаж бровей? Пишите в личку.',
    ],
    [
      'AI service with a link',
      'Сколько времени уходит на создание контента? Более 150 нейросетей и 500 шаблонов в одном приложении: AI-дизайнер, монтаж клипов, помощники для текстов, юрист и репетитор. Всё это примерно по цене двух чашек кофе. Бесплатно зарегистрируйтесь до официального запуска. Презентация [url]. Связь со мной [url].',
    ],
    [
      'first-person bankruptcy service',
      'Долги кажутся безвыходными? Работаем строго по ФЗ-127, берём на себя подготовку документов. Бесплатная консультация.',
    ],
    [
      'who-provides rhetorical service offer',
      'Кто занимается установкой кондиционеров? Нужен прохладный дом? Монтаж от 5000 руб., гарантия, звоните [phone].',
    ],
  ])('keeps a rhetorical-question current offer detectable: %s', (_label, text) => {
    const result = detect(text);

    expect(result).not.toBeNull();
    expect(['REVIEW_ONLY', 'WARN', 'DELETE', 'DELETE_AND_ESCALATE']).toContain(result?.actionBand);
  });

  it('does not let a trailing provider question hide an earlier service advertisement', () => {
    const result = detect(
      'Монтаж кондиционеров от 5000 руб., гарантия, звоните [phone]. Кто занимается установкой кондиционеров?',
    );

    expect(result?.actionBand).toBe('DELETE');
  });

  it.each([
    'Кто делает натяжные потолки? Мы устанавливаем их от 6000 руб. с гарантией, звоните [phone].',
    'Кто делает натяжные потолки? Наша команда устанавливает их от 6000 руб. с гарантией, звоните [phone].',
  ])('recognizes a pronoun-based source-side offer after a provider question: %s', (text) => {
    const result = detect(text);

    expect(result?.actionBand).toBe('DELETE');
  });

  it('does not let group-promotion recall weaken an actionable phone offer', () => {
    const offer =
      'Гелиевые шары и стильные фотозоны на заказ. Доставка к празднику, цена от 3000 руб. Пишите, звоните [phone].';
    const withoutFooter = detect(offer);
    const withFooter = detect(`${offer} Подписывайтесь на наши группы [url].`);

    expect(withFooter?.matchedSignals).not.toContain('recall-cap:warn:explicit-group-promotion');
    expect(withFooter?.actionBand).toBe(withoutFooter?.actionBand);
  });

  it('does not hide a store promotion behind a news-style channel title', () => {
    const result = detect('Новости скидок и акций нашего магазина. Подписывайтесь на канал [url].');

    expect(result?.matchedSignals).toContain('group-promo:explicit-group-promotion');
    expect(result?.actionBand).toBe('WARN');
  });

  it('keeps protest coverage with a closed-store mention editorial', () => {
    expect(
      detect(
        'Новости района: магазин закрылся, прошли акции протеста. Подписывайтесь на канал [url].',
      ),
    ).toBeNull();
  });

  it('keeps an explicit group invitation detectable when it also states group rules', () => {
    const result = detect(
      'Добро пожаловать в нашу группу для общения. Правила: реклама и спам запрещены. Переходите по ссылке ниже [url].',
    );

    expect(result?.primarySubtype).toBe('GROUP_PROMOTION');
    expect(result?.actionBand).toBe('WARN');
  });

  it('keeps a linked group invitation detectable inside a full rules block', () => {
    const result = detect(
      'Добро пожаловать в группу для общения и знакомств. Разрешены музыка и видео. Запрещены любые ссылки, спам и реклама. За нарушение удаляем. Переходите по ссылке ниже [url].',
    );

    expect(result?.primarySubtype).toBe('GROUP_PROMOTION');
    expect(result?.actionBand).toBe('REVIEW_ONLY');
  });

  it('keeps a linked exchange group reviewable despite its rules block', () => {
    const result = detect(
      'Ссылочная радуга. Админы группы кидают ссылки на свои группы три раза в день. Спам и реклама запрещены. За нарушение правил удаление. [url]',
    );

    expect(result?.matchedSignals).toContain('group-promo:link-exchange-group');
    expect(result?.actionBand).toBe('REVIEW_ONLY');
  });

  it('does not let group rules hide an embedded paid editing offer', () => {
    const result = detect(
      'Добро пожаловать в группу фото и видеомонтажа. Можно заказать у админов группы фото или видео монтаж. Любые ссылки, спам и реклама запрещены. За нарушение удаление. [url]',
    );

    expect(result?.matchedSignals).toContain('intent:current-service-booking-offer');
    expect(result?.actionBand).toBe('WARN');
  });

  it('does not read a seller fulfillment follow-up as a buyer review question', () => {
    const result = detect(
      'Сегодня вечером доставка бройлеров 450 р. 40 дней. [phone]. Для заказа звоните. Кто заказывал заранее позвоню.',
    );

    expect(result?.safeContextBucket).toBe('none');
    expect(result?.actionBand).toBe('WARN');
  });

  it('detects a shopping-group promotion after a separate delivery sentence', () => {
    const result = detect(
      'Подписывайся на нашу группу выгодных покупок. Здесь новые качественные товары, которые можно купить дешевле. Доставка по всей России. Подписывайтесь прямо сейчас [url].',
    );

    expect(result?.negativeSignals).not.toContain('search-pattern:request:delivery');
    expect(result?.actionBand).toBe('WARN');
  });

  it('reviews a direct manufacturer offer despite its buyer-oriented hook', () => {
    const result = detect(
      'Хочешь экономить на покупках? Тогда покупай напрямую у производителя. Доставка по всей России, оплата при получении. Нужна помощь в оформлении, пиши [phone] или переходи [url].',
    );

    expect(result?.matchedSignals).toContain('goods-retail:direct-manufacturer-order-offer');
    expect(result?.safeContextBucket).toBe('none');
    expect(result?.actionBand).toBe('REVIEW_ONLY');
  });

  it('keeps a non-breaking-hyphen online store above the request cap', () => {
    const result = detect(
      'Ищете стильную мебель онлайн? Юра мебельный — онлайн‑магазин качественной мебели от проверенных поставщиков. Более 100 цветов диванов, бесплатная доставка и оплата при получении. Нужна помощь с выбором? Напишите в личку [phone].',
      {
        commercialCampaignContext: {
          ...REPEATED_PRIVATE_RESALE_CONTEXT,
          repeatedPhoneDistinctChatCount: 2,
        },
      },
    );

    expect(result?.safeContextBucket).toBe('none');
    expect(result?.actionBand).toBe('WARN');
  });

  it('keeps standalone group rules without an invitation non-commercial', () => {
    expect(
      detect('Правила группы: реклама, спам и внешние ссылки запрещены. За нарушение удаление.'),
    ).toBeNull();
  });

  it.each([
    ['STRICT', 38, 55],
    ['BALANCED', 57, 77],
  ] as const)(
    'distinguishes prohibited and current paid group placement in %s',
    (commercialAdsSensitivity, commercialAdsWarnThreshold, commercialAdsDeleteThreshold) => {
      const settings = {
        commercialAdsSensitivity,
        commercialAdsWarnThreshold,
        commercialAdsDeleteThreshold,
      } as Partial<ChatSettings>;
      const pairs = [
        {
          prohibited:
            'Канал храма: расписание служб. Платная коммерческая реклама не допускается. Пишите админу, ответная ссылка [url].',
          current:
            'Канал храма: расписание служб. Платная коммерческая реклама: пишите админу, ответная ссылка [url].',
        },
        {
          prohibited:
            'Группа музея: афиша выставок. Платная коммерческая реклама не разрешается. Пишите админу, ответная ссылка [url].',
          current:
            'Группа музея: афиша выставок. Платная коммерческая реклама: пишите админу, ответная ссылка [url].',
        },
        {
          prohibited:
            'Группа садоводов: обмен опытом и советы. Платную коммерческую рекламу не размещаем. Пишите админу, ответная ссылка [url].',
          current:
            'Группа садоводов: обмен опытом и советы. Платная коммерческая реклама: пишите админу, ответная ссылка [url].',
        },
        {
          prohibited:
            'Чат дачников: советы по участкам. Не принимаем платную коммерческую рекламу. Пишите админу, ответная ссылка [url].',
          current:
            'Чат дачников: советы по участкам. Платная коммерческая реклама: пишите админу, ответная ссылка [url].',
        },
      ];

      for (const pair of pairs) {
        expect(detect(pair.prohibited, { settings })).toBeNull();
        const current = detect(pair.current, { settings });
        expect(current?.matchedSignals).toContain(
          'recall-source:group-promo:paid-commercial-promo-group',
        );
        expect(current?.actionBand).toBe('WARN');
      }

      const reopened = detect(
        'Канал храма: расписание служб. Платная коммерческая реклама не допускается. Но теперь разрешена платная коммерческая реклама: пишите админу, ответная ссылка [url].',
        { settings },
      );
      expect(reopened?.matchedSignals).toContain(
        'recall-source:group-promo:paid-commercial-promo-group',
      );
      expect(reopened?.actionBand).toBe('WARN');
    },
  );

  it.each([
    'Подпишитесь на канал храма, там расписание служб [url].',
    'Садоводы, подпишитесь на группу для обмена опытом и советами [url].',
    'Новости района: суд рассмотрел дело о продаже квартиры. Подпишитесь на канал [url].',
    'Волонтеры, подпишитесь на группу для координации акции по сбору вещей и доставки гуманитарной помощи [url].',
  ])('keeps a noncommercial group or channel invitation non-actionable: %s', (text) => {
    expect(['ALLOW', 'REVIEW_ONLY']).toContain(detect(text)?.actionBand ?? 'ALLOW');
  });

  it.each([
    'Ссылка на канал школы с расписанием уроков [url].',
    'Ссылка на канал детского сада с объявлениями для родителей [url].',
    'Ссылка на канал библиотеки с афишей бесплатных встреч [url].',
    'Ссылка на канал храма с расписанием служб [url].',
    'Ссылка на канал муниципальной администрации с уведомлениями для жителей [url].',
    'Ссылка на канал волонтерского поискового отряда [url].',
  ])('does not treat an institutional source-side channel link as promotion: %s', (text) => {
    const result = detect(text);

    expect(result?.matchedSignals ?? []).not.toContain('channel-placement:subscribe-channel-link');
    expect(['ALLOW', 'REVIEW_ONLY']).toContain(result?.actionBand ?? 'ALLOW');
    expect(result?.actionable ?? false).toBe(false);
  });

  it.each([
    'Каталог скидок и распродаж обновляется каждый день. Ссылка на канал [url].',
    'Это лишь малая часть интересных историй. Еще больше материалов в канале. Ссылка на канал [url].',
  ])('keeps a qualified source-side channel link detectable: %s', (text) => {
    const result = detect(text);

    expect(result?.matchedSignals).toContain('channel-placement:subscribe-channel-link');
    expect(['WARN', 'DELETE']).toContain(result?.actionBand);
    expect(result?.actionable).toBe(true);
  });

  it.each([
    'Могу выполнить покос травы бензо-триммером, 500р сотка. [phone]',
    'Нужна помощь? Я ясновидящая, работаю только во благо. Провожу диагностику, связаться со мной [phone].',
  ])('keeps an explicit first-person service offer detectable: %s', (text) => {
    expect(['WARN', 'DELETE']).toContain(detect(text)?.actionBand);
  });

  it.each([
    'Подскажите хорошего стоматолога для ребёнка, желательно недалеко от центра?',
    'На массаж нужно записаться?',
    'На прием к юристу нужно записаться?',
    'К мастеру лучше записаться заранее?',
    'Жители дома, подпишитесь на группу нашего ТСЖ для получения уведомлений об отключениях [url].',
    'Пожалуйста, подпишитесь на группу детского сада для объявлений воспитателя [url].',
    'Почему нельзя снимать работу ПВО? Публикация видео помогает противнику определить позицию, поэтому не снимайте и не выкладывайте такие записи.',
  ])('keeps a genuine question or public-safety explanation allowed: %s', (text) => {
    expect(detect(text)).toBeNull();
  });

  it('does not classify broad bath tub retail wording as recruitment', () => {
    const result = detect(
      'Цена за полный комплект. Доставка по региону. Банный чан из нержавеющей стали, работаем по договору. Телефон +7 900 000 00 97.',
    );

    expect(result?.primarySubtype).toBe('GOODS_RETAIL');
    expect(result?.matchedSignals).toContain('goods-retail:bath-tub-retail');
    expect(result?.matchedSignals).not.toContain('recruitment:работа-условия');
  });

  it('escalates obfuscated salary loan leadgen instead of sending it to review only', () => {
    const result = detect(
      'Дeньги дo зapплaты oнлaйн, oдoбpeниe 15 минут, без отказа. Ccылкa в профиле.',
    );

    expect(result?.primarySubtype).toBe('GOODS');
    expect(result?.matchedSignals).toContain('risk:loan-leadgen');
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it('keeps sanitized esoteric service contacts above balanced evidence gates', () => {
    const result = detect(
      'Ольга Романовна - сильнейшая ясновидящая и потомственная гадалка с опытом более 25 лет. Работаю по белой магии. Помогу вернуть гармонию в отношения, увидеть перспективы в финансах и работе. Связь со мной: Max: [phone], WhatsApp: [phone], Telegram: [phone], телефон для звонков: [phone].',
      {
        settings: {
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 60,
          commercialAdsDeleteThreshold: 81,
        },
      },
    );

    expect(result).toBeDefined();
    expect(result?.matchedSignals).toEqual(
      expect.arrayContaining([
        'risk:paid-esoteric-service',
        'transaction:high-risk-offer',
        'contact:whatsapp',
        'contact:telegram',
      ]),
    );
  });

  it('detects emoji separated multi-object Flora showcase under balanced thresholds', () => {
    const result = detect(
      'ЖК Флора 🌱 Г.Сочи Кудепста ♦️ Студия ♦️ 24м2 ♦️ черновая 🔥7.200.000 ♦️ Студия ♦️ 24м2 ♦️ РМТ 🔥8.500.000 ♦️ Студия ♦️ 26м2 ♦️ РМТ 🔥8.600.000 Все предложения по комплексам Флора, Летний и Лестория от собственника на ключах 🔑 📱 +7 900 000 01 01 Виктория',
      {
        commercialCampaignContext: {
          ...REPEATED_PRIVATE_RESALE_CONTEXT,
          senderDistinctChatCount: 1,
          sameTextDistinctChatCount: 1,
          nearTextDistinctChatCount: 1,
          repeatedPhoneDistinctChatCount: 1,
          senderDistinctChatCount5m: 1,
          senderDistinctChatCount30m: 1,
          senderDistinctChatCount120m: 1,
        },
        settings: {
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 55,
          commercialAdsDeleteThreshold: 76,
        },
      },
    );

    expect(result?.primarySubtype).toBe('PROPERTY_AGENT');
    expect(result?.matchedSignals).toContain('property-agent:витрина-объектов-прайс');
    expect(['WARN', 'REVIEW_ONLY']).toContain(result?.actionBand);
  });

  it('detects conditioner install and refill services under balanced thresholds', () => {
    const result = detect(
      'Здравствуйте, оперативно, быстро и качественно выполняем работы по: - установке кондиционеров - обслуживанию -заправке -ремонту Звоните прямо сейчас - начинается горячий сезон. Выезжаем за город. +7 900 000 01 02',
      {
        commercialCampaignContext: {
          ...REPEATED_PRIVATE_RESALE_CONTEXT,
          senderDistinctChatCount: 1,
          sameTextDistinctChatCount: 1,
          nearTextDistinctChatCount: 1,
          repeatedPhoneDistinctChatCount: 1,
          senderDistinctChatCount5m: 1,
          senderDistinctChatCount30m: 1,
          senderDistinctChatCount120m: 1,
        },
        settings: {
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 58,
          commercialAdsDeleteThreshold: 78,
        },
      },
    );

    expect(result?.primarySubtype).toBe('SERVICES');
    expect(result?.matchedSignals).toEqual(
      expect.arrayContaining(['service-specialty:appliance-repair', 'contact:phone']),
    );
    expect(['REVIEW_ONLY', 'WARN']).toContain(result?.actionBand);
  });

  it('detects balcony glazing service under balanced thresholds', () => {
    const result = detect(
      'Остекление и утепление балконов и лоджий, отделка пространства под ключ. Бесплатный замер и расчет стоимости, телефон +7 900 000 02 03',
      {
        settings: {
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 55,
          commercialAdsDeleteThreshold: 76,
        },
      },
    );

    expect(result?.primarySubtype).toBe('SERVICES');
    expect(result?.matchedSignals).toEqual(
      expect.arrayContaining([
        'service-specialty:balcony-glazing-service',
        'transaction:implied-price',
        'contact:phone',
      ]),
    );
  });

  it('does not let generic medical appointment wording become buyout evidence', () => {
    const result = detect(
      'Медицинский центр: УЗИ, анализы, прием терапевта и невролога. Скидка 15%, запись +7 900 000 00 93.',
    );

    expect(result?.primarySubtype).toBe('SERVICES');
    expect(result?.matchedSignals).not.toContain('buyout:прием');
    expect(result?.matchedSignals).not.toContain('buyout:приём');
  });

  it('does not let material procurement wording become buyout evidence for services', () => {
    const result = detect(
      'Все виды электромонтажных работ, помощь закупки материалов, розетки, автоматы, щитки. Телефон +7 900 000 00 98.',
    );

    expect(result?.primarySubtype).toBe('SERVICES');
    expect(result?.matchedSignals).not.toContain('buyout:закуп');
    expect(result?.matchedSignals).not.toContain('buyout:livestock-procurement');
  });

  it('keeps campaign-heavy third-party chat directories review-only instead of delete', () => {
    const result = detect(
      'Подббдд 1 /2 Чаты 1 женский чат https://max.ru/join/a 2 доска объявлений обгэс https://max.ru/join/b 3 доска объявлений 1 https://max.ru/join/c 4 взаимосылочная 1 https://max.ru/join/d 5 группа для женщин причёски, мода, домоводство https://max.ru/join/e 6 НСК и НСО доска объявлений https://max.ru/join/f 7 Нск пристань надежда для бездомных животных https://max.ru/join/g 8 Нск и НСО недвижимость https://max.ru/join/h 9 Нск и НСО аренда квартир https://max.ru/join/i 10 Новосибирск https://max.ru/join/j 11 НСО и Новосибирск https://max.ru/join/k 12 женский журнал https://max.ru/join/l 13 Нск и НСО отдам - возьму в дар https://max.ru/join/m 14 Нск и НСО работа https://max.ru/join/n 15 Нск и НСО услуги https://max.ru/join/o 16 Нск и НСО реклама https://max.ru/join/p',
      {
        commercialCampaignContext: {
          senderDistinctChatCount: 7,
          sameTextDistinctChatCount: 6,
          repeatedPhoneDistinctChatCount: 0,
          repeatedLinkDistinctChatCount: 6,
          nearTextDistinctChatCount: 6,
          repeatedDomainDistinctChatCount: 21,
          repeatedHandleDistinctChatCount: 0,
          senderDistinctChatCount5m: 6,
          senderDistinctChatCount30m: 6,
          senderDistinctChatCount120m: 7,
        },
      },
    );

    expect(result?.primarySubtype).toBe('CHANNEL_PLACEMENT');
    expect(result?.actionBand).toBe('REVIEW_ONLY');
    expect(result?.reviewRecommended).toBe(true);
    expect(result?.reasonCodes).toContain('fp-risk-high');
  });

  it.each([
    [
      'accountant recommendation request',
      'Посоветуйте бухгалтера для ИП, кто хорошо сдаёт отчетность?',
    ],
    [
      'yandex direct recommendation request',
      'Кто настраивал Яндекс Директ, подскажите нормального специалиста?',
    ],
    ['medical center recommendation request', 'Кто знает хороший медицинский центр для УЗИ?'],
    [
      'rehabilitation center recommendation request',
      'Кто знает хороший реабилитационный центр, родственнику нужна помощь?',
    ],
    [
      'plain medical appointment queue',
      'Прием у врача задержали на 40 минут, кто сейчас в очереди?',
    ],
    [
      'non promotional accounting report mention',
      'Бухгалтер сдал отчетность, декларации и налоги вчера, можно больше не переживать.',
    ],
    [
      'delivery discussion in private messages from fourteen hour audit false positive',
      'Эта доставка мне в личку пишет.',
    ],
    [
      'long delivery complaint from fourteen hour audit false positive',
      'Я писала выше, что на доставке она мне в личку ещё звонит, адрес знает, потом всё удалили после разборки.',
    ],
    [
      'private one off shoes resale from fourteen hour audit false positive',
      'Продам полусапожки весна осень, размер 38, состояние отличное - 1300 руб.',
    ],
    [
      'private home textile resale from twenty four hour audit false positive',
      'Продается новый комплект дивандеков. Эти стильные чехлы идеально подходят для защиты дивана от загрязнений. Комплект включает два чехла размером 90см /210см. Не подошли нам, сразу не успели сдать. На Озоне один стоит 1895р. Отдам дешевле, чем приобрела на маркетплейсе. Оба за 2700р.',
    ],
    [
      'private kiosk single object resale from twenty four hour audit false positive',
      'Срочно продаю киоск в хорошем состоянии. Металлический киоск белого цвета, площадью около 10 кв.м. Требуется небольшой косметический ремонт фасада. Стоимость 40 тыс. руб., торг возможен. По всем вопросам звоните по номеру телефона +7 900 000 10 31.',
    ],
    [
      'animal adoption relocation mention is not logistics advertising',
      'Кошка ищет дом, отдают в добрые руки при переезде, пишите в личку.',
    ],
    [
      'quoted commercial text is discussion, not own ad',
      'Сосед прислал рекламу: "Скидка на курс, пишите в личку, цена 3000 руб". Такое удаляем?',
    ],
    [
      'channel metrics report with explicit not selling placement',
      'Отчет по каналу: ER24 12%, рекламный пост стоил 500р у конкурента, размещение не продаём.',
    ],
    [
      'admin moderation discussion about ad spam',
      'Админы, спамер кидает рекламу, бот удаляет такие сообщения или нужно настроить фильтр?',
    ],
    [
      'low quantity plant giveaway stays private',
      'Отдам денежное дерево по 50 руб за шт, в наличии 3 шт, есть с корнями, район Комета',
    ],
    [
      'private low quantity money tree stays private with unit price wording',
      'Отдам денежное дерево по 50 руб за шт, всего 3 шт, есть с корнями, район Комета',
    ],
    [
      'local news subscribe footer from sixteen hour audit false positive',
      'Возле села Еловка на дорогу внезапно выбежал лось. Водители, будьте внимательны. Томск Сейчас | Подписаться https://example.com',
    ],
    [
      'road repair news subscribe footer from sixteen hour audit false positive',
      'В Томске завершается ремонт дороги после жалоб местных жителей. Томск Сейчас | Подписаться https://example.com',
    ],
    [
      'public city improvement voting from sixteen hour audit false positive',
      'Уважаемые жители города Азова! Идет голосование за объекты благоустройства, поддержите проект по ссылке https://example.com',
    ],
    [
      'contest voting from sixteen hour audit false positive',
      'Началось онлайн-голосование участников конкурса, каждый голос это шаг к победе. https://example.com',
    ],
    [
      'delivery request please from sixteen hour audit false positive',
      'Здравствуйте. Можно доставку пожалуйста! Если можно то в ЛС',
    ],
    [
      'job seeking typo from sixteen hour audit false positive',
      'Ищю подработку/любой калым писать в ЛС или обращаться по номеру +7 900 000 01 22',
    ],
    [
      'rideshare free seats from sixteen hour audit false positive',
      'Водитель завтра 03.06 Абакан Таштып Абаза, 3 места, +7 900 000 01 23',
    ],
    [
      'volunteer pet adoption delivery from sixteen hour audit false positive',
      'Есть примета, кто готов? Девочка ласковая, доставка за счет группы Помощь хвостикам +7 900 000 01 24',
    ],
    [
      'private manicure table resale from sixteen hour audit false positive',
      'Продам маникюрный стол со всем, что на фото, 5000 рублей. +7 900 000 01 25',
    ],
    [
      'private Toyota Vitz resale with ex wording from sixteen hour audit false positive',
      'Продам Toyota Vitz 2010 года, экс владелец, пробег 120000, цена 600000, +7 900 000 01 26',
    ],
    [
      'government services status is not benefit phishing',
      'На госуслугах можно проверить статус заявления, ссылка есть на сайте администрации.',
    ],
    [
      'ordinary meeting plus response is not service cta',
      'Кто идет завтра на встречу, ставьте плюс.',
    ],
    [
      'civic bare domain is not commercial generic domain',
      'На сайте администрации example-raion.ru опубликован график отключений воды.',
    ],
    [
      'civic email contact is not commercial contact',
      'Почта администрации для жалоб info@example.ru, напишите обращение по форме.',
    ],
    [
      'third party chat directory with links is not own channel placement ad',
      'Подборка полезных чатов района: женский чат https://max.ru/join/a, доска объявлений https://max.ru/join/b, соседи https://max.ru/join/c.',
    ],
    [
      'district group directory with job and service group names stays allowed',
      'Присоединяйся к группам по Краснокаменску и округу. Добавляйте контакты, чтобы не потерять любимые группы: Работа, Вакансии Краснокаменск https://max.ru/join/a, Недвижимость Краснокаменск https://max.ru/join/b, Услуги Краснокаменск https://max.ru/join/c.',
    ],
    [
      'realtor group catalog with price word in title stays allowed',
      'ГРУППЫ ДЛЯ КОЛЛЕГ С ЭКСКЛЮЗИВНОЙ НЕДВИЖИМОСТЬЮ. Вступай скорее. 1. Основной канал https://max.ru/join/a 2. Каталог групп https://max.ru/join/b 3. Первая цена https://max.ru/join/c 4. Вся недвижимость https://max.ru/join/d.',
    ],
    [
      'private avito resale stays private',
      'Продам детскую коляску б/у, самовывоз, ссылка на avito.ru/items/private-stroller, цена 3000 руб.',
    ],
    [
      'private auto exchange with starter is not auto-parts retail',
      'Обмен. Мото не предлагать Ока. стартер новый, генератор, документы.',
    ],
    [
      'private auto engine exchange with repair wording is not a service offer',
      'Обмен. Мото не предлагать. ДВС после капремонта, ставился новый венец, не сошёлся со стартером, нужно поменять. Двигатель обкатку не прошёл. Остальное в ЛС, в комплект отдам поршни, клапаны, вкладыши, кольца новые.',
    ],
    [
      'youtube tutorial with no ads is not a setup service',
      'Без рекламы: видео на YouTube как настроить роутер дома, просто инструкция для соседей https://youtube.com/watch?v=abc',
    ],
    [
      'official government app store link is not app directory spam',
      'Официальное приложение Госуслуги можно скачать в App Store: https://apps.apple.com/ru/app/gosuslugi/id123456',
    ],
    [
      'official work app store link is not app directory spam',
      'Официальное приложение Работа России можно скачать в App Store: https://apps.apple.com/ru/app/trudvsem/id123',
    ],
    [
      'news intensity wording is not info product',
      'Магнитная буря началась, в ближайшие часы интенсивность геомагнитных возмущений может усилиться. Прислать новость https://example.com/news',
    ],
    [
      'work app store tutorial is not app directory spam',
      'Инструкция: скачайте приложение Работа России через App Store, чтобы проверить статус резюме https://apps.apple.com/ru/app/trudvsem/id123',
    ],
    [
      'civic benefit instruction on administration site is not phishing',
      'Компенсацию за ЖКХ оформляют через Госуслуги, заявление по ссылке на сайте администрации https://example-raion.ru/benefits',
    ],
    [
      'fraud warning quoting loan ad is not a commercial loan offer',
      'Полиция предупреждает: мошенники рассылают займ без отказа, не переходите по ссылкам',
    ],
    [
      'private low quantity seedlings stay private',
      'Продам рассаду помидоров, осталось 10 штук по 50 рублей, самовывоз, пишите в личку',
    ],
    [
      'short private seedling leftovers without named varieties stays private',
      'Продам остатки рассады помидоров, 10 штук по 50 рублей, самовывоз',
    ],
    [
      'short private seedling leftovers without price stays private',
      'Продам остатки рассады помидоров, самовывоз',
    ],
    [
      'rideshare passenger wording is not logistics service',
      'Водитель завтра Абакан Таштып Абаза, 3 места по 500 рублей, перевозка пассажиров, телефон +7 900 000 10 06',
    ],
    [
      'student seeking marketplace side job stays allowed',
      'Студент ищет подработку на Ozon или WB, график после учебы, писать в личку',
    ],
    [
      'home dumplings recommendation request stays allowed',
      'Кто делает домашние пельмени, посоветуйте контакты.',
    ],
    [
      'home dairy recommendation request stays allowed',
      'Кто покупал козье молоко и творог у соседей, посоветуйте проверенные контакты.',
    ],
    [
      'buyer strawberry route order request stays allowed',
      'Добрый день, а можно сделать заказ на клубнику Азию по маршруту автобуса, может быть будет кому-то удобно попутно?',
    ],
    [
      'commercial property recommendation request stays allowed',
      'Подскажите, где недорого снять кабинет для занятий два раза в неделю?',
    ],
    [
      'info product experience question stays allowed',
      'Кто проходил курс по маркетплейсам, стоит ли своих денег? Нужны отзывы.',
    ],
    [
      'loan discussion is not loan leadgen',
      'Подскажите, кто брал кредит в банке, какие ставки сейчас?',
    ],
    [
      'credit history advice question is not loan leadgen',
      'Кредитная история испортилась, кто знает как исправить без новых займов?',
    ],
    [
      'job seeking with payment details stays allowed',
      'Ищу подработку на лето с ежедневной оплатой, писать в личку.',
    ],
    [
      'personal project volunteer request stays allowed',
      'Нужны люди в проект двора на субботник, без оплаты, просто помочь соседям.',
    ],
    [
      'rideshare with price stays allowed',
      'Водитель завтра Абакан Таштып Абаза, 3 места по 500 рублей, телефон +7 900 000 03 04.',
    ],
    [
      'personal car pickup is not auto buyout',
      'Заберу авто из сервиса после ремонта, расчет уже закрыт по заказ-наряду.',
    ],
    [
      'private land construction context is not building service',
      'Земельный участок ровный, при строительстве жилого дома сырости не будет. Свет рядом, цена 350 000, телефон +7 900 000 10 21.',
    ],
    [
      'livestock logistics note is not procurement',
      'Приедем заберём коров с пастбища после дождя, хозяин уже предупредил.',
    ],
    [
      'chat recommendation with profile link stays allowed',
      'Посоветуйте чат для мам, ссылка в профиле у соседки не открывается.',
    ],
    [
      'third party obfuscated domain due diligence stays allowed',
      'Кто пользовался сервисом example dot ru, стоит ли платить 3000 руб?',
    ],
    [
      'resale pricing discussion from twenty four hour audit false positive',
      'Если оптовик покупает по 700 р, то можно смело продавать по 1500.',
    ],
    [
      'news subscription wording with in course idiom stays allowed',
      'Подпишитесь, чтобы быть в курсе городских новостей и важных объявлений администрации. https://example.com/news',
    ],
    [
      'rental owner without commission stays allowed',
      'Сдам квартиру, собственник, без комиссии, залог 10000.',
    ],
    [
      'short stay apartment request stays allowed',
      'Ищу квартиру посуточно на выходные, посоветуйте варианты.',
    ],
    [
      'school voting likes without pay stay allowed',
      'Поставьте лайк посту школы, это голосование без оплаты.',
    ],
    [
      'school voting likes without pay and link stay allowed',
      'Поставьте лайк посту школы, это голосование без оплаты https://example.com/vote',
    ],
    [
      'max support operator story stays allowed',
      'Оператор поддержки MAX ответил в чате, проблема решена.',
    ],
    [
      'cargo service availability question stays allowed',
      'Здравствуйте, грузоперевозки в группе есть?)',
    ],
    ['vp school homework stays allowed', 'ВП по математике задали на завтра, кто понял задачу?'],
    [
      'pin chat rules request stays allowed',
      'Закрепите правила чата, чтобы новички видели их сверху.',
    ],
    [
      'question quoting third party service ad stays allowed',
      'Кто пользовался услугами мастера из объявления "ремонт окон от 3000, звоните"? Это нормальный специалист или реклама?',
    ],
    [
      'course due diligence with price stays allowed',
      'Кто проходил курс по маркетплейсам за 3000 руб, стоит ли своих денег? Нужны отзывы.',
    ],
    [
      'ozon delivery complaint with cash request stays allowed',
      'Заказал на Ozon доставку, курьер просит оплату наличными и пишет в личку, это нормально?',
    ],
    [
      'channel ad due diligence with metrics stays allowed',
      'Кто покупал рекламу в этом канале: ER24 8%, цена за пост 500р, статистика похожа на накрутку?',
    ],
    [
      'generic district news subscribe footer stays allowed',
      'Сегодня в парке открыли новую детскую площадку после ремонта. Подписывайтесь на канал района https://example.com/news',
    ],
    [
      'private used dress resale with avito delivery stays allowed',
      'Продам платье б/у, размер 44, не подошло. Возможна доставка по России Авито доставкой, цена 1200 руб.',
    ],
    [
      'private seedling leftovers with one price stay allowed',
      'Лишняя рассада после посадки: помидоры бычье сердце, черри, перец желтый. Отдам по 30 руб, самовывоз.',
    ],
    [
      'private seedling leftovers with several small prices stay allowed',
      'Продам остатки рассады: томаты 5 шт по 50 руб, перец 4 шт по 60 руб, самовывоз.',
    ],
    [
      'district news channel subscription stays allowed',
      'Подписывайтесь на наш канал района, новости каждый день https://t.me/news',
    ],
    [
      'library master class sign-up stays allowed',
      'Мастер-класс в библиотеке, запись по ссылке https://example.ru/event',
    ],
    [
      'currency exchange rate news is not an info product',
      'Курс доллара сегодня вырос, подробности https://example.ru/news',
    ],
    [
      'debt relief legal discussion stays allowed',
      'Кто проходил банкротство физлица, сколько длится суд и какие документы нужны?',
    ],
    [
      'debt relief scam warning stays allowed',
      'Юристы предупреждают: объявления "спишем долги за неделю" часто мошеннические, не переводите предоплату.',
    ],
    [
      'wildberries buyer review complaint stays allowed',
      'Купила товар на Wildberries, отзыв не проходит модерацию в приложении, кто сталкивался?',
    ],
    [
      'wildberries buyer review complaint with help link stays allowed',
      'Купила товар на Wildberries, отзыв не проходит модерацию в приложении, кто сталкивался? https://example.com/help',
    ],
    [
      'local client search seminar recap stays allowed',
      'На семинаре обсуждали поиск клиентов для мастеров красоты, без продаж и ссылок.',
    ],
    [
      'local client search seminar recap with materials link stays allowed',
      'На семинаре обсуждали поиск клиентов для мастеров красоты, материалы по ссылке https://example.com/recap',
    ],
    [
      'chat bot monetization settings discussion stays allowed',
      'Чат-бот показывает монетизацию канала в настройках, рекламу мы не продаём.',
    ],
    [
      'bank referral code due diligence stays allowed',
      'Кто пользовался реферальным кодом банка, бонус реально начисляют или реклама?',
    ],
  ])('allows %s', (_label, text) => {
    expect(detect(text)).toBeNull();
  });

  it('still detects paid course ads after narrowing course marker', () => {
    const result = detect(
      'Открыт набор на курс по маркетплейсам. Цена 3000 руб, места ограничены, пишите в личку.',
    );

    expect(result?.primarySubtype).toBe('INFO_PRODUCT');
    expect(result?.matchedSignals).toContain('info:курс');
    expect(['WARN', 'REVIEW_ONLY']).toContain(result?.actionBand);
    expect(result?.reasonCodes).toContain('evidence:DIRECT');
    expect(result?.reasonCodes).not.toContain('evidence:action-direct');
  });

  it('deletes paid course ads when independent action-direct evidence is present', () => {
    const result = detect(
      'Открыт набор на курс по маркетплейсам. Цена 3000 руб, места ограничены, запись https://max.ru/join/course.',
    );

    expect(result?.primarySubtype).toBe('INFO_PRODUCT');
    expect(result?.matchedSignals).toContain('info:курс');
    expect(result?.matchedSignals).toContain('deal-channel:link');
    expect(result?.actionBand).toBe('DELETE');
    expect(result?.reasonCodes).toContain('evidence:action-direct');
  });

  it('flags short collectible flower retail under balanced real chat thresholds', () => {
    const result = detect('Сортовые фиалки по вопросам в личку', {
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 50,
        commercialAdsDeleteThreshold: 70,
      },
    });

    expect(result?.primarySubtype).toBe('GOODS_RETAIL');
    expect(result?.matchedSignals).toContain('goods-retail:collectible-flower-retail');
    expect(result?.matchedSignals).toContain('transaction:retail-inquiry');
    expect(result?.actionBand).toBe('REVIEW_ONLY');
  });

  it('warns on short structured service phone ads under soft balanced thresholds', () => {
    const cargo = detect('ГРУЗОПЕРЕВОЗКИ +7 900 000 10 42', {
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 57,
        commercialAdsDeleteThreshold: 77,
      },
    });
    const beauty = detect(
      'Приглашаю тебя красотка! На окрашивание, окудрение, флисинг, карвинг, реконструкцию волос. Я жду тебя по адресу Титова 238 салон Корона или пиши/звони +7 900 000 10 43 Наталья',
      {
        settings: {
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 57,
          commercialAdsDeleteThreshold: 77,
        },
      },
    );

    expect(cargo?.primarySubtype).toBe('SERVICES');
    expect(cargo?.matchedSignals).toContain('transaction:structured-service-phone-offer');
    expect(cargo?.actionBand).toBe('WARN');
    expect(beauty?.primarySubtype).toBe('SERVICES');
    expect(beauty?.matchedSignals).toContain('transaction:structured-service-phone-offer');
    expect(beauty?.actionBand).toBe('WARN');
  });

  it.each([
    [
      'print copy',
      'Печать фото и документов, ксерокопия, распечатка, ламинирование. Адрес: Ленина 10. Тел. +7 900 000 20 01',
      'service-specialty:print-copy-service',
      'REVIEW_ONLY',
    ],
    [
      'tool rental',
      'Прокат инструмента: перфоратор, болгарка, сварочный аппарат. Залог. Телефон +7 900 000 21 01',
      'service-specialty:tool-rental-service',
      'REVIEW_ONLY',
    ],
    [
      'locksmith',
      'Вскрытие замков круглосуточно, аварийное открытие дверей. Телефон +7 900 000 21 04',
      'service-specialty:locksmith-service',
      'REVIEW_ONLY',
    ],
    [
      'well drilling',
      'Бурение скважин на воду, обсадные трубы, гарантия. Телефон +7 900 000 21 05',
      'service-specialty:well-drilling-service',
      'WARN',
    ],
    [
      'sewer cleaning',
      'Прочистка канализации, устранение засоров, выезд круглосуточно +7 900 000 21 06',
      'service-specialty:sewer-cleaning-service',
      'REVIEW_ONLY',
    ],
  ])(
    'keeps structured %s phone ads actionable under soft balanced thresholds',
    (_label, text, signal, expectedAction) => {
      const result = detect(text, {
        settings: {
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 57,
          commercialAdsDeleteThreshold: 77,
        },
      });

      expect(result?.primarySubtype).toBe('SERVICES');
      expect(result?.matchedSignals).toContain(signal);
      expect(result?.matchedSignals).toContain('transaction:structured-service-phone-offer');
      expect(result?.actionBand).toBe(expectedAction);
      if (expectedAction === 'WARN') {
        expect(result?.suppressionReasons).toContain('conservative-recall-warn-cap');
      }
    },
  );

  it('flags long yard work and moving service ads under soft balanced thresholds', () => {
    const result = detect(
      'ДАЧНЫЕ РАБОТЫ НА ВАШЕМ УЧАСТКЕ. Расчистка участка вручную, спецтехника, Камаз под вывоз мусора. Звоните +7 900 000 10 44. Земельные работы, спил деревьев, планировка участка, грузоперевозки, переезды любой сложности, грузчики, демонтаж построек. Низкие цены.',
      {
        settings: {
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 57,
          commercialAdsDeleteThreshold: 77,
        },
      },
    );

    expect(result?.primarySubtype).toBe('SERVICES');
    expect(result?.matchedSignals).toEqual(
      expect.arrayContaining([
        'service-specialty:грузчик',
        'service-specialty:грузоперевоз',
        'contact:phone',
      ]),
    );
    expect(result?.negativeSignals).not.toContain('private:переезд');
    expect(['WARN', 'REVIEW_ONLY']).toContain(result?.actionBand);
  });

  it.each([
    [
      'charcoal production workers',
      'Всем доброго времени суток. Требуются рабочие на производство изготовления древесного угля. Обращаться по номеру телефона +7 900 000 10 45 Павел',
      57,
      77,
      'recruitment:требуется',
    ],
    [
      'pickup point order clerk',
      'На постоянную работу требуется ПРИЕМЩИК ЗАКАЗОВ. Стажировка оплачивается, график сменный 2/2, выплата 2 раза в месяц, официальное оформление. Телефон +7 900 000 10 46 MAX.',
      60,
      82,
      'recruitment:people-work-conditions',
    ],
  ])(
    'flags %s vacancy ads under soft balanced thresholds',
    (_label, text, warnThreshold, deleteThreshold, signal) => {
      const result = detect(text, {
        settings: {
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: warnThreshold,
          commercialAdsDeleteThreshold: deleteThreshold,
        },
      });

      expect(result?.primarySubtype).toBe('RECRUITMENT');
      expect(result?.matchedSignals).toContain(signal);
      expect(result?.matchedSignals).toContain('contact:phone');
      expect(['WARN', 'REVIEW_ONLY']).toContain(result?.actionBand);
    },
  );

  it('keeps handmade self channel promo reviewable under soft balanced thresholds', () => {
    const result = detect(
      'Всем привет) Добро пожаловать в мой Мир страз Юлии. Уникальные и индивидуальные изделия ручной работы от магнитов и футболок, до инкрустации любой вещи. До 1 июля можно забрать портрет из страз со скидкой в 50%. Всего 3 портрета, может это твой? Буду рада всем в своем блестящем мире. МОЙ КАНАЛ',
      {
        settings: {
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 55,
          commercialAdsDeleteThreshold: 75,
        },
      },
    );

    expect(result?.primarySubtype).toBe('CHANNEL_PLACEMENT');
    expect(result?.matchedSignals).toContain('transaction:handmade-channel-offer');
    expect(result?.negativeSignals).toContain('context:question');
    expect(result?.actionBand).toBe('REVIEW_ONLY');
  });

  it('does not suppress retail fragrance promos on open-for-yourself wording', () => {
    const result = detect(
      'Откройте для себя коллекцию селективных ароматов. Доступные цены: полный флакон 2400₽, мини-версия 250₽, сет из 10 ароматов 2400₽.',
      {
        settings: {
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 45,
          commercialAdsDeleteThreshold: 65,
        },
      },
    );

    expect(result?.primarySubtype).toBe('GOODS_RETAIL');
    expect(result?.matchedSignals).toContain('goods-retail:fragrance-retail-promo');
    expect(result?.negativeSignals).not.toContain('negative:для себя');
    expect(['WARN', 'REVIEW_ONLY']).toContain(result?.actionBand);
  });

  it('keeps personal fragrance for-yourself wording suppressed', () => {
    const result = detect(
      'Брала аромат для себя, но не подошел. Один флакон, отдам за 1500 руб, самовывоз.',
    );

    expect(result).toBeNull();
  });

  it('detects mixed-script sale ads with obfuscated MAX links', () => {
    const result = detect('Пpодaм айфон, скидкa, писать hxxps://max dot ru/join/sale');

    expect(result?.primarySubtype).toBe('GOODS');
    expect(result?.matchedSignals).toEqual(
      expect.arrayContaining(['intent:продам', 'promo:скидк', 'deal-channel:link']),
    );
    expect(result?.actionBand).toBe('REVIEW_ONLY');
  });

  it('escalates obfuscated payday-loan leadgen links', () => {
    const result = detect('Дeньги дo зapплaты oнлaйн, oдoбpим бeз oткaзa, hxxp://credit dot ru');

    expect(result?.primarySubtype).toBe('GOODS');
    expect(result?.matchedSignals).toEqual(
      expect.arrayContaining(['risk:loan-leadgen', 'deal-channel:link']),
    );
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it('keeps ambiguous unit-price phone shorthand as a deliberate non-fix', () => {
    const result = detect('400р.кг Т. +7 900 000 00 00');

    expect(result).toBeNull();
  });

  it('keeps ordinary pc sale out of betting high risk and auto-delete', () => {
    const result = detect(
      'Полный комплект ПК для работы и учебы, игр, тянет GTA V и прочие. 4-ядерный процессор AMD A10. Возможна доставка. Цена 10500 +7 900 000 10 13. Звоните, тут не могу ответить.',
    );

    expect(result?.primarySubtype).toBe('GOODS');
    expect(['WARN', 'REVIEW_ONLY']).toContain(result?.actionBand);
    expect(result?.matchedSignals).not.toContain('risk:betting-gambling');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it('keeps banquet vacancy out of bank card high risk', () => {
    const result = detect(
      'Вакансия. Требуются повара, ставка от 5500 +банкетные. График 6/1, официальное оформление. Связь: +7 900 000 10 14',
    );

    expect(result?.primarySubtype).toBe('RECRUITMENT');
    expect(result?.actionBand).toBe('DELETE');
    expect(result?.matchedSignals).not.toContain('risk:bank-card-leadgen');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it('keeps massage service out of messaging automation and channel placement', () => {
    const result = detect(
      'Приглашаем на массаж за 1800₽ для новых клиентов. У нас остаются 99% из всех пришедших! Запись/консультация +7 900 000 10 15',
    );

    expect(result?.primarySubtype).toBe('SERVICES');
    expect(result?.actionBand).toBe('DELETE');
    expect(result?.matchedSignals).not.toContain('risk:messaging-automation');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it('does not treat salon discussion without contact as a beauty service ad', () => {
    const result = detect(
      'Салон Корона после ремонта стал уютнее, но цены на окрашивание в городе вообще выросли.',
    );

    expect(result?.matchedSignals ?? []).not.toContain('service-specialty:beauty-salon-service');
  });

  it.each([
    [
      'print copy question',
      'Где сделать ксерокс документов недалеко от школы?',
      'service-specialty:print-copy-service',
    ],
    [
      'tool borrowing note',
      'Сосед дал перфоратор без аренды, верну завтра.',
      'service-specialty:tool-rental-service',
    ],
    [
      'locksmith request',
      'Подскажите мастера по замкам, кто вскрывал дверь?',
      'service-specialty:locksmith-service',
    ],
    [
      'well drilling discussion',
      'Кто бурил скважину на воду, сколько метров получилось?',
      'service-specialty:well-drilling-service',
    ],
    [
      'sewer cleaning discussion',
      'Засор канализации в подъезде, управляющая компания обещала прочистку.',
      'service-specialty:sewer-cleaning-service',
    ],
  ])('does not treat %s as structured service ad', (_label, text, signal) => {
    const result = detect(text);

    expect(result?.matchedSignals ?? []).not.toContain(signal);
    expect(result).toBeNull();
  });

  it('does not treat an ordinary personal channel mention as handmade channel promo', () => {
    const result = detect(
      'Мой канал с заметками про ручную работу пока закрыт, скидок и заказов там нет.',
    );

    expect(result?.matchedSignals ?? []).not.toContain(
      'channel-placement:handmade-self-channel-promo',
    );
  });

  it('still escalates bank card leadgen after tightening bank word boundaries', () => {
    const result = detect(
      'Альфа-Банк. Дарим 500 ₽ за оформление Альфа-Карты. Подробности по ссылке https://example.com/card',
    );

    expect(result?.primarySubtype).toBe('GOODS');
    expect(result?.matchedSignals).toContain('risk:bank-card-leadgen');
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it('still detects messaging automation after removing bare ban word', () => {
    const result = detect(
      'Новый софт для автоматической рассылки по чатам в MAX: прокси, аккаунты, база сообщений. Купить можно на канале https://example.com/soft',
    );

    expect(result?.primarySubtype).toBe('SERVICES');
    expect(result?.matchedSignals).toContain('risk:messaging-automation');
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it('does not classify collectible flower starters as auto parts', () => {
    const result = detect(
      'Эксклюзивные коллекционные фиалки, детки и стартеры, упаковка, отправка СДЭК, 150 руб.',
    );

    expect(result?.primarySubtype).toBe('GOODS_RETAIL');
    expect(result?.matchedSignals).toContain('goods-retail:collectible-flower-retail');
    expect(result?.matchedSignals).not.toContain('goods-retail:auto-parts-retail');
    expect(result?.matchedSignals).not.toContain('property-agent:эксклюзив');
  });

  it('does not treat the domain portion of an email as a generic deal channel', () => {
    const result = detect(
      'Бухгалтерское сопровождение ИП и ООО, отчетность и декларации. Заявки на почту buh-office@example.com',
    );

    expect(result?.matchedSignals).toContain('contact:email');
    expect(result?.matchedSignals).not.toContain('deal-channel:generic-domain');
  });

  it('classifies wood portrait orders as services instead of property agent exclusives', () => {
    const result = detect(
      'Эксклюзивный портрет на дереве. Ваши фото на дереве, заготовки, подарите близким. Заказывают по телефону +7 900 000 02 06.',
    );

    expect(result?.primarySubtype).toBe('SERVICES');
    expect(result?.matchedSignals).toContain('intent:custom-art-order');
    expect(result?.matchedSignals).not.toContain('property-agent:эксклюзив');
  });

  it('keeps repeated private clothing resale out of commercial actions even with campaign context', () => {
    const result = detect(
      'Продам детские вещи: куртка р-р 122 сост. отличное 700 руб, сапоги р-р 30 сост. хорошее 500 руб, шапка 150 руб. Пишите в личку.',
      { commercialCampaignContext: REPEATED_PRIVATE_RESALE_CONTEXT },
    );

    expect(result).toBeNull();
  });

  it('uses buyout transaction evidence for delete decisions when a strong contact is present', () => {
    const result = detect(
      'Срочно выкупим авто после ДТП без документов, деньги сразу, эвакуатор бесплатно. Пишите @auto_cash.',
    );

    expect(result?.primarySubtype).toBe('BUYOUT');
    expect(result?.actionBand).toBe('DELETE');
    expect(result?.reasonCodes).toContain('evidence:action-direct');
    expect(result?.reasonCodes).toContain('evidence:direct:transaction-contact');
  });

  it('detects bulk material sale with phone-only question wording', () => {
    const result = detect('ПРОДАМ СЫПУЧИЕ МАТЕРИАЛЫ! ВОПРОСЫ +7 900 000 00 00');

    expect(result?.primarySubtype).toBe('GOODS_RETAIL');
    expect(result?.matchedSignals).toContain('goods-retail:bulk-materials');
    expect(result?.matchedSignals).toContain('contact:phone');
  });

  it('treats MAX and MAH reply CTA as contact for explicit services', () => {
    const serviceInMax = detect('Маникюр, запись открыта, пишите в МАХ');
    const repairInMax = detect('Ремонт квартир, пишите в MAX');

    expect(serviceInMax?.primarySubtype).toBe('SERVICES');
    expect(serviceInMax?.matchedSignals).toContain('contact:пишите в мах');
    expect(repairInMax?.primarySubtype).toBe('SERVICES');
    expect(repairInMax?.matchedSignals).toContain('contact:пишите в max');
  });

  it('keeps recent audit service and produce misses covered', () => {
    const electrical = detect(
      'Электромонтажные работы любой сложности. Сварочные и сантехнические работы. Отопление. +7 900 000 00 00',
    );
    const moving = detect(
      'ПЕРЕЕЗДЫ ПОД КЛЮЧ. ДОМАШНИЙ ДАЧНЫЙ ОФИСНЫЙ. ГРУЗЧИКИ АККУРАТНЫЕ. ВЫВОЗ МУСОРА. ГАЗЕЛЬ КАМАЗ ЗИЛ +7 900 000 00 00 ЗВОНИТЕ',
    );
    const strawberry = detect(
      'Продается домашняя клубника. Ягода крупная, сладкая. Суходол т +7 900 000 00 00',
    );

    expect(electrical?.primarySubtype).toBe('SERVICES');
    expect(electrical?.matchedSignals).toContain('service-specialty:электромонтаж');
    expect(electrical?.matchedSignals).toContain('contact:phone');
    expect(moving?.primarySubtype).toBe('SERVICES');
    expect(moving?.matchedSignals).toContain('service-specialty:moving-cargo-service');
    expect(strawberry?.primarySubtype).toBe('GOODS_RETAIL');
    expect(strawberry?.matchedSignals).toContain('goods-retail:wholesale-produce');
  });

  it('rescues explicit service-phone ads at balanced thresholds without deleting them', () => {
    const settings = {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 57,
      commercialAdsDeleteThreshold: 77,
    } as const;
    const cases = [
      {
        text: 'Покос травы триммером. Там где мы там чисто. +7 900 000 00 00',
        signal: 'service-specialty:yard-cleanup-service',
        actionBand: 'REVIEW_ONLY',
      },
      {
        text: 'НАТЯЖНЫЕ ПОТОЛКИ, рулонные шторы, жалюзи. Бесплатный замер, завтра монтаж. +7 900 000 00 00',
        signal: 'service-specialty:stretch-ceiling-service',
        actionBand: 'REVIEW_ONLY',
      },
      {
        text: 'Ремонт стиральных машин НА ДОМУ. Я лично отвечаю на звонки и сам приезжаю на ремонт. Опыт более 15 лет. +7 900 000 00 00',
        signal: 'service-specialty:appliance-repair',
        actionBand: 'WARN',
      },
    ];

    for (const { text, signal, actionBand } of cases) {
      const result = detect(text, { settings });

      expect(result?.primarySubtype).toBe('SERVICES');
      expect(result?.actionBand).toBe(actionBand);
      expect(result?.matchedSignals).toContain(signal);
      expect(result?.matchedSignals).toContain('contact:phone');
      if (actionBand === 'REVIEW_ONLY') {
        expect(result?.classifierReasons).toContain('rescued-structured-service-phone');
      }
    }
  });

  it('detects fresh 48h goods retail misses without escalating private-like sales', () => {
    const berry = detect(
      'Жимолость Бакчарский питомник: ручной сбор в контейнерах по 2 л - 400 ₽ / литр, механический сбор в коробках по 5 л - 350 ₽ / литр. +7 900 000 00 00',
      {
        settings: {
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 57,
          commercialAdsDeleteThreshold: 77,
        },
      },
    );
    const brick = detect(
      'Бой кирпича с доставкой камазом. Чем ближе к району, тем дешевле. Принимаю заявки +7 900 000 00 00',
      {
        settings: {
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 57,
          commercialAdsDeleteThreshold: 77,
        },
      },
    );
    const poultry = detect('Продам домашних кур бройлеров. Цена 450 рублей за килограмм.', {
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 57,
        commercialAdsDeleteThreshold: 77,
      },
    });

    expect(berry?.primarySubtype).toBe('GOODS_RETAIL');
    expect(berry?.actionBand).toBe('REVIEW_ONLY');
    expect(berry?.safeContextBucket).toBe('private_one_off_sale');
    expect(berry?.matchedSignals).toContain('goods-retail:wholesale-produce');
    expect(berry?.matchedSignals).toContain('combo:contact+price');

    expect(brick?.primarySubtype).toBe('GOODS_RETAIL');
    expect(brick?.actionBand).toBe('REVIEW_ONLY');
    expect(brick?.matchedSignals).toContain('goods-retail:bulk-materials');

    expect(poultry?.primarySubtype).toBe('GOODS_RETAIL');
    expect(poultry?.actionBand).toBe('REVIEW_ONLY');
    expect(poultry?.matchedSignals).toContain('goods-retail:farm-livestock-retail');
    expect(poultry?.negativeSignals).not.toContain('private:property-sale');
  });

  it.each([
    [
      'home dairy',
      'Предлагаю домашнюю молочку: творог, сметана, яйца. Развоз по району, цена от 150 руб. Телефон +7 900 000 00 00',
      'goods-retail:home-dairy-retail',
    ],
    [
      'seedlings',
      'Продам рассаду томатов и перцев, сортовая, 60 руб за штуку. Самовывоз, звоните +7 900 000 00 00',
      'goods-retail:plant-nursery-stock',
    ],
    [
      'home food',
      'Домашние пельмени и вареники под заказ, доставка по району, 450 руб за кг. Телефон +7 900 000 00 00',
      'goods-retail:home-food-order',
    ],
  ])('keeps local %s price-phone listings out of auto-delete', (_label, text, signal) => {
    const result = detect(text, {
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 57,
        commercialAdsDeleteThreshold: 77,
      },
    });

    expect(result?.primarySubtype).toBe('GOODS_RETAIL');
    expect(result?.matchedSignals).toContain(signal);
    expect(result?.matchedSignals).toContain('combo:contact+price');
    expect(result?.actionBand).not.toBe('DELETE');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
    expect(result?.reasonCodes).toContain('policy:guarded-local-direct');
  });

  it('keeps strong linked retail ads deletable after local price-phone guard', () => {
    const result = detect(
      'Домашняя молочка с доставкой: творог, сметана, сыр. Цена от 150 руб, заказ через каталог https://example.com/milk, телефон +7 900 000 00 00',
      {
        settings: {
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 57,
          commercialAdsDeleteThreshold: 77,
        },
      },
    );

    expect(result?.primarySubtype).toBe('GOODS_RETAIL');
    expect(result?.matchedSignals).toContain('deal-channel:link');
    expect(result?.actionBand).toBe('DELETE');
    expect(result?.reasonCodes).toContain('evidence:action-direct');
  });

  it('detects structured service, taxi, property booking, and placement offers without hard deleting them', () => {
    const settings = {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 57,
      commercialAdsDeleteThreshold: 77,
    } as const;
    const service = detect(
      'Ремонт квартир под ключ, выезд на замер, гарантия по договору. Пишите для консультации.',
      { settings },
    );
    const taxi = detect(
      'Такси межгород ежедневно, комфортный водитель, есть места, пишите для заказа.',
      { settings },
    );
    const property = detect(
      'Сдаются домики у озера посуточно, свободные даты на июль, бронь в личку.',
      { settings },
    );
    const placement = detect('Канал про город, свободные окна на завтра, стату скину в личку.', {
      settings,
    });

    expect(service?.primarySubtype).toBe('SERVICES');
    expect(service?.matchedSignals).toContain('transaction:structured-service-offer');
    expect(['WARN', 'REVIEW_ONLY']).toContain(service?.actionBand);
    expect(taxi?.primarySubtype).toBe('SERVICES');
    expect(taxi?.matchedSignals).toContain('service-specialty:taxi-transport-service');
    expect(['WARN', 'REVIEW_ONLY']).toContain(taxi?.actionBand);
    expect(property?.primarySubtype).toBe('PROPERTY_AGENT');
    expect(property?.matchedSignals).toContain('transaction:property-booking-offer');
    expect(['WARN', 'REVIEW_ONLY']).toContain(property?.actionBand);
    expect(placement?.primarySubtype).toBe('CHANNEL_PLACEMENT');
    expect(placement?.matchedSignals).toContain('transaction:channel-placement-offer');
    expect(['WARN', 'REVIEW_ONLY']).toContain(placement?.actionBand);
  });

  it('keeps neighboring request and private-real-estate wording suppressed', () => {
    expect(
      detect('Кто делает покос травы триммером, подскажите телефон', {
        settings: {
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 57,
          commercialAdsDeleteThreshold: 77,
        },
      }),
    ).toBeNull();
    expect(
      detect(
        'Добрый день, а можно сделать заказ на клубнику Азию по маршруту автобуса, может быть будет кому-то удобно попутно?',
      ),
    ).toBeNull();
    expect(
      detect('Продам дом, цена 450000 рублей, участок 6 соток', {
        settings: {
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 57,
          commercialAdsDeleteThreshold: 77,
        },
      }),
    ).toBeNull();
  });

  it('does not rescue generic service mentions with phone-like references', () => {
    const settings = {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 57,
      commercialAdsDeleteThreshold: 77,
    } as const;

    for (const text of [
      'Ремонт в доме закончен. Телефон мастера +7 900 000 00 00, если нужны документы по работам.',
      'Бригада приехала и работает на объекте. Телефон прораба +7 900 000 00 00.',
      'Плановый электромонтаж завершён. Телефон администрации +7 900 000 00 00.',
    ]) {
      expect(detect(text, { settings })).toBeNull();
    }
  });

  it('enforces standalone service evidence even when the same contact forms a campaign', () => {
    const result = detect(
      'Предлагаю свои услуги по ремонту кровли гаражей. Работаю по договору, гарантия 5 лет. Звоните [phone]',
      {
        commercialCampaignContext: {
          ...REPEATED_PRIVATE_RESALE_CONTEXT,
          repeatedPhoneDistinctChatCount: 3,
        },
        settings: {
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 45,
          commercialAdsDeleteThreshold: 65,
        },
      },
    );

    expect(result?.primarySubtype).toBe('SERVICES');
    expect(result?.evidenceStrength).toBe('STRUCTURED');
    expect(result?.reviewReasons).not.toContain('campaign-dependent');
    expect(result?.actionBand).toBe('WARN');
  });

  it('does not turn a repeated wellness diary into an info-product offer', () => {
    const result = detect(
      'Завтра быстрый и вкусный завтрак: огурец, зелень, сыр, яйцо, греческий йогурт. После завтрака коллаген. Сегодня снова записи по самочувствию и питанию, курс привычек идет спокойно.',
      {
        commercialCampaignContext: {
          ...REPEATED_PRIVATE_RESALE_CONTEXT,
          sameTextDistinctChatCount: 4,
        },
      },
    );

    expect(result).toBeNull();
  });

  it.each([
    [
      'short cleaning service',
      'Химчистка мебели, матрасов, стульев и ковров на выезд. +7 900 000 30 01',
    ],
    [
      'short electrician service',
      'Электрик +7 900 000 30 02, на сообщения не отвечаю, только звонки',
    ],
    ['short taxi service', 'Такси межгород 24/7 +7 900 000 30 03'],
  ])('warns on an unambiguous %s with a phone', (_label, text) => {
    const result = detect(text, {
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 45,
        commercialAdsDeleteThreshold: 65,
      },
    });

    expect(result?.primarySubtype).toBe('SERVICES');
    expect(result?.actionBand).toBe('WARN');
    expect(result?.classifierReasons).toContain('cleared-structured-service-phone');
  });

  it('warns on explicit store inventory without treating a bare availability reply as an ad', () => {
    const store = detect('В магазине Палитра Вкуса в наличии шашлык: свинина, курица.', {
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 45,
        commercialAdsDeleteThreshold: 65,
      },
    });

    expect(store?.primarySubtype).toBe('GOODS_RETAIL');
    expect(store?.actionBand).toBe('WARN');
    expect(detect('Есть, весь в наличии')).toBeNull();
  });

  it.each([
    [
      'qualified job seeker',
      'Добрый день. Ищу любую подработку. С ежедневной оплатой. [phone] Иван',
    ],
    [
      'specialist contact request',
      'Добрый день! Напишите, пожалуйста, есть ли у кого-нибудь номер специалиста по ремонту холодильного оборудования. Тел. [phone].',
    ],
    [
      'buyer order list',
      'Примите пожалуйста заявку: филе горбуши 1 упаковка, сыр 1 штука. [phone] Рашида',
    ],
    ['buyer availability question', 'На заказ делаете или есть в наличии?'],
    ['turkic taxi request', '9 остановка до Озерной че такси херек [phone]'],
    [
      'fuel availability report',
      'Татнефть на Ново-Садовой: 92, 95 и ДТ все в наличии, очередь небольшая.',
    ],
    [
      'animal adoption with delivery',
      'Щенкам срочно нужен дом, помогите малышам, возможна доставка и помощь в стерилизации [phone]',
    ],
    [
      'missing person public help',
      'СУРГУТ, ОЧЕНЬ НУЖНА ВАША ПОМОЩЬ! ПРОПАЛ МОЙ СЫН! Кто видел, сообщите по телефону [phone].',
    ],
    [
      'disaster fundraiser',
      'После взрыва газа семья осталась без квартиры. Открыт сбор помощи семье, пожертвования по номеру [phone].',
    ],
    ['default max invite', 'Я пользуюсь мессенджером MAX. Присоединяйся! [url]'],
  ])('suppresses the audited non-commercial context: %s', (_label, text) => {
    expect(detect(text)).toBeNull();
  });

  it('keeps a Rostelecom service offer deletable and out of messaging-automation risk', () => {
    const result = detect(
      'Меня зовут Ольга, менеджер компании ПАО Ростелеком. Подключаем интернет: оптоволокно прямо в дом. Телевидение, видеонаблюдение для безопасности дома и участка, мобильная связь за 300 руб. Уточнить тарифы и оставить заявку: звоните [phone], WhatsApp. Бонусы при подключении.',
      {
        settings: {
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 45,
          commercialAdsDeleteThreshold: 65,
        },
      },
    );

    expect(result?.primarySubtype).toBe('SERVICES');
    expect(result?.matchedSignals).not.toContain('risk:messaging-automation');
    expect(result?.matchedSignals).not.toContain('service-specialty:marketing-automation');
    expect(result?.safeContextBucket).toBe('none');
    expect(result?.actionBand).toBe('DELETE');
  });

  it('keeps a private constructor toy sale suppressed while retaining explicit shop inventory', () => {
    expect(
      detect(
        'Продам детский конструктор, один набор, собирали пару раз. Коробка целая, самовывоз, цена 900 руб.',
      ),
    ).toBeNull();

    const shop = detect(
      'В магазине Игрушки в наличии новые конструкторы, цена от 900 руб. Оформите заказ по ссылке [url].',
    );
    expect(shop?.primarySubtype).toBe('GOODS_RETAIL');
    expect(shop?.negativeSignals).not.toContain('search-pattern:request:order-or-application');
    expect(shop?.actionBand).toBe('DELETE');
  });

  it('does not mistake salary paid to a card for bank-card lead generation', () => {
    const vacancy = detect(
      'Вахта на складе бытовой техники. Оплата 4500 ₽ за смену, авансы каждую неделю, зарплата на вашу карту или карту третьего лица. Оформление как самозанятый. График 6/1. Телефон [phone].',
    );

    expect(vacancy?.primarySubtype).toBe('RECRUITMENT');
    expect(vacancy?.matchedSignals).not.toContain('risk:bank-card-leadgen');
    expect(vacancy?.actionBand).not.toBe('DELETE_AND_ESCALATE');

    const leadgen = detect(
      'Альфа-Банк дарит 500 ₽ за оформление банковской карты и кэшбэк. Получить карту по ссылке [url].',
    );
    expect(leadgen?.matchedSignals).toContain('risk:bank-card-leadgen');
    expect(leadgen?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it('does not mistake pictures and links in group rules for bank-card lead generation', () => {
    const result = detect(
      'Добро пожаловать в группу. Здесь запрещены картинки и ссылки на заработок, спам и оскорбления. За нарушение правил бан.',
    );

    expect(result).toBeNull();
  });

  it('keeps paid group-placement terms commercial despite rules wording', () => {
    const result = detect(
      'Правила размещения рекламы в нашей группе: стоимость поста 1000 руб. Для заказа рекламного места пишите в личку [url].',
    );

    expect(result).not.toBeNull();
    expect(['REVIEW_ONLY', 'WARN', 'DELETE']).toContain(result?.actionBand);
  });

  it('keeps an independent service ad actionable after group rules', () => {
    const result = detect(
      'Правила группы: картинки, ссылки и спам запрещены, за нарушение бан. Ремонт холодильников, цена 2000 руб, звоните [phone].',
    );

    expect(result).not.toBeNull();
    expect(result?.negativeSignals).not.toContain('context:moderation-ad-discussion');
    expect(['WARN', 'DELETE']).toContain(result?.actionBand);
  });

  it.each([
    'Вакансия на складе, зарплата на карту. Альфа-Банк платит 500 ₽ при оформлении, https://example.com/card. Телефон +7 900 000 40 09.',
    'Вакансия на складе, зарплата на карту. Карта Альфа-Банка, оформление онлайн, выплата 500 ₽. https://example.com/card',
  ])('keeps embedded bank referral risk in a salary-card vacancy', (text) => {
    const result = detect(text);

    expect(result?.matchedSignals).toContain('risk:bank-card-leadgen');
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it('does not mistake employee cashback in a bank vacancy for card lead generation', () => {
    const result = detect(
      'Вакансия в Альфа-Банке. Официальное оформление по ТК, зарплата на вашу карту. Сотрудникам кэшбэк на обеды. Телефон +7 900 000 40 10.',
    );

    expect(result?.matchedSignals ?? []).not.toContain('risk:bank-card-leadgen');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it('separates a free promotional giveaway from a paid-entry raffle', () => {
    const freeGiveaway = detect(
      'ВНИМАНИЕ! РОЗЫГРЫШ 50 000 РУБЛЕЙ ЗА ПОДПИСКУ В КАНАЛ. Автор зарабатывает на спорте, ссылка [url].',
    );
    expect(freeGiveaway).not.toBeNull();
    expect(freeGiveaway?.matchedSignals).toContain('business:promotional-giveaway');
    expect(freeGiveaway?.matchedSignals).not.toContain('risk:paid-raffle');
    expect(freeGiveaway?.actionBand).not.toBe('DELETE_AND_ESCALATE');

    const paidRaffle = detect(
      'Набор в группу: стань одним из победителей. Призовые лоты, стоимость номерка 350 рублей. Оплата переводом, выберите номер. Взаимный обмен. [url]',
    );
    expect(paidRaffle?.matchedSignals).toContain('risk:paid-raffle');
    expect(paidRaffle?.safeContextBucket).toBe('none');
    expect(paidRaffle?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it('does not let a self-authored НЕ СПАМ disclaimer suppress paid-review risk', () => {
    const scam = detect(
      'НЕ СПАМ. Платим 3500 ₽ за отзыв на Wildberries: ежедневные задания, без опыта и вложений. Пиши плюс в рабочий чат [url].',
    );

    expect(scam?.matchedSignals).toContain('risk:paid-review-task');
    expect(scam?.safeContextBucket).toBe('none');
    expect(scam?.actionBand).toBe('DELETE_AND_ESCALATE');

    expect(
      detect(
        'Осторожно, мошенники предлагают платить за отзывы. Не переходите по их ссылкам и сообщите о спаме администратору.',
      ),
    ).toBeNull();
  });

  it('escalates fake education documents without flagging licensed study', () => {
    const fakeDocuments = detect(
      'Документы об образовании без обучения и экзаменов, с гарантией внесения в реестр. Нужен диплом или аттестат? Оперативное оформление. Пишите в WhatsApp [phone] или Telegram [url].',
    );

    expect(fakeDocuments?.matchedSignals).toContain('risk:document-service');
    expect(fakeDocuments?.actionBand).toBe('DELETE_AND_ESCALATE');

    const licensedStudy = detect(
      'Учебный центр приглашает пройти очное обучение 256 часов с экзаменом и последующей выдачей диплома о переподготовке. Лицензия указана на сайте [url].',
    );
    expect(licensedStudy?.matchedSignals ?? []).not.toContain('risk:document-service');
    expect(licensedStudy?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it('escalates pseudomedical replacement claims but not ordinary diagnostic imaging', () => {
    const pseudomedical = detect(
      'Акция: биорезонансное обследование организма заменяет биохимию крови, МРТ, КТ и УЗИ, выявляет причины аллергии и бесплодия. Предварительная запись [phone].',
    );

    expect(pseudomedical?.matchedSignals).toContain('risk:pseudomedical-diagnostics');
    expect(pseudomedical?.actionBand).toBe('DELETE_AND_ESCALATE');

    const imaging = detect(
      'Медицинский центр проводит МРТ и УЗИ по направлению врача. Результаты описывает врач-рентгенолог, запись по телефону [phone].',
    );
    expect(imaging?.matchedSignals ?? []).not.toContain('risk:pseudomedical-diagnostics');
    expect(imaging?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it('treats short availability phrases as replies, not standalone inventory ads', () => {
    expect(detect('Есть, весь в наличии')).toBeNull();
    expect(detect('Там всё в наличии.')).toBeNull();

    const inventory = detect(
      'В магазине Палитра Вкуса в наличии шашлык: свинина и курица. Заказы по телефону [phone].',
    );
    expect(inventory?.primarySubtype).toBe('GOODS_RETAIL');
    expect(inventory?.actionBand).toBe('WARN');
  });

  it('does not treat торговом зале as a private bargaining marker', () => {
    const vacancy = detect(
      'Требуется продавец для работы в торговом зале. График 2/2, зарплата 50000 руб. Запись на собеседование [phone].',
    );

    expect(vacancy?.primarySubtype).toBe('RECRUITMENT');
    expect(vacancy?.negativeSignals).not.toContain('private:торг');
    expect(vacancy?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it('does not hide a risky landing page behind a generic invite phrase', () => {
    const result = detect('Присоединяйся! https://win4land.com');

    expect(result?.matchedSignals).toContain('risk:casino-landing-link');
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it('keeps animal and fuel public-context rules conditional on commercial evidence', () => {
    const breeder = detect(
      'Питомник предлагает породистого щенка. Щенок ищет семью, цена 50000 руб, открыта бронь. Телефон +7 900 000 40 01.',
    );
    const fuelRetailer = detect(
      'АЗС Энергия: АИ-95 в наличии, очередь для клиентов небольшая. Цена 70 руб/литр, скидка по карте. Заказ топлива и доставка [phone].',
    );

    expect(breeder?.primarySubtype).toBe('GOODS_RETAIL');
    expect(breeder?.actionBand).not.toBe('REVIEW_ONLY');
    expect(fuelRetailer).not.toBeNull();
    expect(fuelRetailer?.actionBand).not.toBe('REVIEW_ONLY');

    expect(
      detect('Щенок ищет семью и добрые руки. Отдаём бесплатно, возможна доставка.'),
    ).toBeNull();
    expect(
      detect('На АЗС есть АИ-95, очередь небольшая, машин немного, лимит по приложению.'),
    ).toBeNull();
  });

  it('detects a professional breeder offer without requiring a quoted price', () => {
    const result = detect(
      'Питомник предлагает породистых щенков с документами РКФ. Щенок ищет семью, открыта бронь. Телефон +7 900 000 40 19.',
    );

    expect(result?.matchedSignals).toContain('goods-retail:animal-breeder-retail');
    expect(result?.actionBand).toBe('WARN');
  });

  it.each([
    'Продам одного породистого щенка, привит, цена 15000 руб. Телефон +7 900 000 40 41.',
    'Продаю щенка девочку породы русский той терьер, возраст три месяца. Кушает хорошо, ласковая, вопросы по телефону +7 900 000 40 42.',
    'Продам одного щенка, документы и ветпаспорт есть, привит, цена 15000 руб. Телефон +7 900 000 40 47.',
  ])('keeps a single private puppy sale out of breeder retail', (text) => {
    expect(detect(text)).toBeNull();
  });

  it('keeps a shelter-style kennel post out of breeder retail', () => {
    const result = detect(
      'Питомник-приют спас щенков. Щенки привиты и ищут добрые семьи, отдаём бесплатно. Телефон волонтёра +7 900 000 40 32.',
    );

    expect(result?.matchedSignals ?? []).not.toContain('goods-retail:animal-breeder-retail');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    'АЗС Энергия: АИ-95 и ДТ в наличии, очередей нет. Скидка 10% по карте, работаем круглосуточно. Телефон +7 900 000 40 20.',
    'Доставка топлива для бизнеса. ДТ в наличии, лимитов нет, звоните +7 900 000 40 21.',
  ])('detects an explicit fuel retailer despite availability-report wording', (text) => {
    const result = detect(text);

    expect(result).not.toBeNull();
    expect(result?.actionBand).not.toBe('REVIEW_ONLY');
  });

  it.each([
    ['STRICT', 38, 55],
    ['BALANCED', 57, 77],
  ] as const)(
    'keeps a closed fuel retailer non-actionable in %s',
    (commercialAdsSensitivity, commercialAdsWarnThreshold, commercialAdsDeleteThreshold) => {
      const result = detect(
        'АЗС Энергия закрыта навсегда. Телефон справочной [phone]. Бензина в продаже больше нет.',
        {
          settings: {
            commercialAdsSensitivity,
            commercialAdsWarnThreshold,
            commercialAdsDeleteThreshold,
          },
        },
      );

      expect(result?.matchedSignals ?? []).not.toContain(
        'recall-source:goods-retail:explicit-fuel-retail',
      );
      expect(result?.actionable ?? false).toBe(false);
    },
  );

  it.each([
    ['STRICT', 38, 55],
    ['BALANCED', 57, 77],
  ] as const)(
    'keeps an explicitly reopened fuel retailer actionable in %s',
    (commercialAdsSensitivity, commercialAdsWarnThreshold, commercialAdsDeleteThreshold) => {
      const result = detect(
        'АЗС Энергия раньше была закрыта. Но сейчас снова работаем: АИ-95 в наличии, скидка по карте. Телефон [phone].',
        {
          settings: {
            commercialAdsSensitivity,
            commercialAdsWarnThreshold,
            commercialAdsDeleteThreshold,
          },
        },
      );

      expect(result?.matchedSignals).toContain('recall-source:goods-retail:explicit-fuel-retail');
      expect(result?.actionable).toBe(true);
    },
  );

  it.each([
    ['STRICT', 38, 55],
    ['BALANCED', 57, 77],
  ] as const)(
    'carries inactive fuel-retailer context across historical follow-ups in %s',
    (commercialAdsSensitivity, commercialAdsWarnThreshold, commercialAdsDeleteThreshold) => {
      for (const text of [
        'АЗС закрылась в прошлом году. Тогда бензин АИ-95 был в наличии по 70 руб/л. Звоните в архив [phone].',
        'АЗС больше не работает. Бензин АИ-95 в наличии по 70 руб/л. Телефон справочной [phone].',
        'АЗС закрыта. По старому объявлению бензин АИ-95 в наличии по 70 руб/л, звоните [phone].',
        'АЗС закрылась в прошлом году. Сейчас на нашей АЗС музей. Тогда бензин АИ-95 был в наличии по 70 руб/л. Звоните в архив [phone].',
        'АЗС закрылась в прошлом году. Сейчас там кафе. Тогда бензин АИ-95 был в наличии по 70 руб/л. Телефон архива [phone].',
      ]) {
        const result = detect(text, {
          settings: {
            commercialAdsSensitivity,
            commercialAdsWarnThreshold,
            commercialAdsDeleteThreshold,
          },
        });

        expect(result?.matchedSignals ?? []).not.toContain(
          'recall-source:goods-retail:explicit-fuel-retail',
        );
        expect(result?.actionable ?? false).toBe(false);
      }
    },
  );

  it.each([
    ['STRICT', 38, 55],
    ['BALANCED', 57, 77],
  ] as const)(
    'recognizes current fuel sources and partial outages after inactive wording in %s',
    (commercialAdsSensitivity, commercialAdsWarnThreshold, commercialAdsDeleteThreshold) => {
      for (const text of [
        'Старая АЗС закрылась в прошлом году. Теперь на нашей АЗС АИ-95 в наличии по 70 руб/л, звоните [phone].',
        'Старая АЗС закрылась в прошлом году. АЗС Энергия работает: АИ-95 в наличии по 70 руб/л, звоните [phone].',
        'Проезд к АЗС Энергия закрыт на ремонт. Сама АЗС работает: АИ-95 в наличии по 70 руб/л, звоните [phone].',
        'На АЗС Энергия временно не работает терминал оплаты. АИ-95 в наличии по 70 руб/л, звоните [phone].',
        'На АЗС Энергия временно не работает касса. АИ-95 в наличии по 70 руб/л, звоните [phone].',
        'На АЗС Энергия закрылась одна колонка. АИ-95 в наличии по 70 руб/л, звоните [phone].',
        'АЗС Энергия не работает ночью. Днем АИ-95 в наличии по 70 руб/л, звоните [phone].',
        'АЗС Энергия закрыта на ремонт. С понедельника снова работаем: АИ-95 в наличии по 70 руб/л, звоните [phone].',
      ]) {
        const result = detect(text, {
          settings: {
            commercialAdsSensitivity,
            commercialAdsWarnThreshold,
            commercialAdsDeleteThreshold,
          },
        });

        expect(result?.matchedSignals).toContain('recall-source:goods-retail:explicit-fuel-retail');
        expect(result?.actionable).toBe(true);
      }
    },
  );

  it.each([
    ['STRICT', 38, 55],
    ['BALANCED', 57, 77],
  ] as const)(
    'detects compensated military contract recruitment without reading fighter assembly as charity in %s',
    (commercialAdsSensitivity, commercialAdsWarnThreshold, commercialAdsDeleteThreshold) => {
      const result = detect(
        'Сбор бойцов на фронт. Помощь при заключении контракта. Единовременная выплата 200000 руб. Места ограничены. Звоните [phone].',
        {
          settings: {
            commercialAdsSensitivity,
            commercialAdsWarnThreshold,
            commercialAdsDeleteThreshold,
          },
        },
      );

      expect(result?.matchedSignals).toContain('recruitment:контрактная-служба');
      expect(result?.negativeSignals).not.toContain('context:public-help-request');
      expect(result?.actionable).toBe(true);
    },
  );

  it.each([
    ['STRICT', 38, 55],
    ['BALANCED', 57, 77],
  ] as const)(
    'keeps qualified fighter aid and non-commercial assembly non-actionable in %s',
    (commercialAdsSensitivity, commercialAdsWarnThreshold, commercialAdsDeleteThreshold) => {
      for (const text of [
        'Сбор помощи бойцам на фронт. Добровольный взнос можно перевести по реквизитам [url]. Поддержим надежный тыл.',
        'Сбор бойцов перед выездом на фронт. Встречаемся у штаба, проверяем списки и экипировку.',
        'Сбор помощи бойцам на передовой. Волонтерская организация бесплатно оказывает услуги по доставке гуманитарных грузов. Нужны вещи и медикаменты, поддержите надежный тыл. Для координации звоните [phone].',
        'Компания добровольцев бесплатно предоставляет услуги по сборке гуманитарных наборов для бойцов. Открыт сбор помощи, перевод по реквизитам [card], звоните координатору [phone].',
      ]) {
        expect(
          detect(text, {
            settings: {
              commercialAdsSensitivity,
              commercialAdsWarnThreshold,
              commercialAdsDeleteThreshold,
            },
          })?.actionable ?? false,
        ).toBe(false);
      }
    },
  );

  it.each([
    ['STRICT', 38, 55],
    ['BALANCED', 57, 77],
  ] as const)(
    'detects commercial school-goods channel teasers without suppressing institutional channels in %s',
    (commercialAdsSensitivity, commercialAdsWarnThreshold, commercialAdsDeleteThreshold) => {
      for (const text of [
        'Скидки на товары для школы. Еще больше акций и распродаж. Ссылка на канал [url].',
        'Школьные товары со скидкой и новые акции каждую неделю. Ссылка на канал [url].',
        'Партнер школы №5, магазин Канцлер: скидки на канцтовары. Еще больше акций и распродаж. Ссылка на канал [url].',
        'Школа опубликовала объявление. Отдельно: магазин Канцлер, приходите к нам за скидками [url].',
        'Волонтеры координируют доставку гуманитарной помощи. Отдельно: наш магазин товаров, приходите к нам [url].',
      ]) {
        expect(
          detect(text, {
            settings: {
              commercialAdsSensitivity,
              commercialAdsWarnThreshold,
              commercialAdsDeleteThreshold,
            },
          })?.actionable,
        ).toBe(true);
      }

      for (const text of [
        'Официальный канал школы №5. Акция по сбору макулатуры. Ссылка на канал [url].',
        'Родителям школы: расписание уроков и новости класса. Ссылка на канал [url].',
        'Школа 17 проводит акцию добрых дел. Призы участникам. Ссылка на канал [url].',
        'Школа Радуга проводит акцию добрых дел. Призы участникам. Ссылка на канал [url].',
      ]) {
        expect(
          detect(text, {
            settings: {
              commercialAdsSensitivity,
              commercialAdsWarnThreshold,
              commercialAdsDeleteThreshold,
            },
          })?.actionable ?? false,
        ).toBe(false);
      }
    },
  );

  it('treats an editorial fuel price report as analytics despite its price and news footer', () => {
    const text =
      'По данным еженедельного мониторинга, средняя цена бензина АИ-95 выросла на 1,2 процента, а стоимость дизельного топлива снизилась на 0,4 процента. Подписаться | Предложить новость [url].';

    expect(detect(text)).toBeNull();
  });

  it.each([
    'По данным мониторинга магазина АИ-95 подорожал до 60 руб. за литр. В обзоре цитируем пример: «заказывайте по телефону [phone]». Это образец рекламы, не предложение.',
    'По данным мониторинга магазина АИ-95 подорожал до 60 руб. за литр. В обзоре цитируем пример: «заказывайте по телефону [phone]». Это образец рекламы, а не предложение.',
    'По данным мониторинга магазина АИ-95 подорожал до 60 руб. за литр. В обзоре приводим пример рекламы: «заказывайте по телефону [phone]». Это не предложение, а образец рекламы.',
  ])('does not join an editorial fuel report to a quoted advertising example: %s', (text) => {
    expect(detect(text)).toBeNull();
  });

  it.each([
    [
      'Мы продаем АИ-95 по 60 руб. за литр, звоните [phone].',
      'Мы продаем АИ-95 по 60 руб. за литр, звоните [phone]. В обзоре цитируем пример: «заказывайте по телефону [phone]». Это образец рекламы, не предложение.',
    ],
    [
      'Ремонт холодильников, цена 2000 руб., звоните [phone].',
      'В обзоре приводим пример рекламы: «заказывайте по телефону [phone]». Это не предложение, а образец рекламы. Отдельно: ремонт холодильников, цена 2000 руб., звоните [phone].',
    ],
  ])('keeps an independent offer outside a quoted advertising example', (offer, mixed) => {
    const baseline = detect(offer);
    const result = detect(mixed);

    expect(baseline).not.toBeNull();
    expect(result?.actionBand).toBe(baseline?.actionBand);
    expect(result?.matchedSignals).toContain('locality:independent-commercial-offer');
  });

  it.each([
    'По данным обзора поставщик сообщил: «Предлагает АИ-95 оптом по 60 руб. за литр». Телефон редакции [phone].',
    'Представитель магазина заявил: «АИ-95 в наличии, заказывайте по телефону [phone]».',
  ])('keeps an attributed fuel-seller quote editorial: %s', (text) => {
    expect(detect(text)).toBeNull();
  });

  it('treats a regulator fuel-price report as analytics', () => {
    const text =
      'Жители столкнулись с резким ростом цен на топливо: литр бензина доходил до 170 рублей. УФАС сообщило, что картельного сговора не выявлено, а причина связана с высокой закупочной стоимостью топлива. Региональные власти договорились о временном контроле цены. Формально рынок работал без нарушений. Продолжение [url].';

    expect(detect(text)).toBeNull();
  });

  it.each([
    'На АЗС Энергия средняя цена АИ-95 выросла за неделю до 70 руб/литр. Сегодня скидка 10% по карте, работаем круглосуточно, звоните [phone].',
    'По данным мониторинга, средняя цена бензина выросла за неделю. Отдельно: АЗС Энергия предлагает АИ-95 по 70 руб/литр со скидкой, заказ и доставка по телефону [phone].',
    'Продаем дизельное топливо оптом: средняя цена на рынке выросла, а у нас 65 руб. за литр, скидка от 1000 литров, пишите [phone].',
    'По данным мониторинга цена бензина выросла. В нашем магазине АИ-95 по 60 руб. за литр, заказывайте [phone].',
    'По данным мониторинга цена бензина выросла. В нашем магазине АИ-95 по 60 р. за литр, заказывайте [phone].',
    'По данным мониторинга цена бензина выросла. В нашем магазине АИ-95 по 60 руб. за литр. Заказывайте [phone].',
    'По данным мониторинга цена бензина выросла. В нашем магазине АИ-95; цена 60 руб. за литр; заказывайте [phone].',
    'По данным мониторинга цена бензина выросла. В нашем магазине бензин по 60 руб. за литр, заказывайте [phone].',
    'По данным мониторинга цена бензина выросла. В нашем магазине АИ‑95 по 60 руб. за литр, заказывайте [phone].',
  ])('does not hide a current fuel offer behind price-analysis wording: %s', (text) => {
    const result = detect(text);

    expect(result).not.toBeNull();
    expect(['WARN', 'DELETE']).toContain(result?.actionBand);
  });

  it('recognizes a direct abbreviated diesel offer inside fuel-price analysis', () => {
    const result = detect(
      'Предлагаем ДТ оптом: средняя цена на рынке выросла, 65 руб. за литр, звоните [phone].',
    );

    expect(result?.actionBand).toBe('WARN');
  });

  it('does not hide a medtech offer behind a fuel-abbreviation substring match', () => {
    const result = detect(
      'Предлагаем медтехнику оптом: средняя цена на рынке выросла, у нас 6500 руб., звоните [phone].',
    );

    expect(result?.actionBand).toBe('WARN');
  });

  it('keeps a voluntary frontline fundraiser out of commercial enforcement', () => {
    const result = detect(
      'Открыт добровольный сбор помощи бойцам на передовой. Нужны автомобили и квадрокоптеры, общая сумма большая. Каждый небольшой взнос помогает закрыть заявки и может спасти жизнь. Перевод по реквизитам [card], ссылка на группу [url].',
    );

    expect(result).toBeNull();
  });

  it('does not hide a military equipment shop behind aid wording', () => {
    const result = detect(
      'ДронСнаб — официальный магазин квадрокоптеров для бойцов на передовой. Большой ассортимент в наличии, оптовые цены, гарантия, скидка 10%, доставка по России. Заказывайте [phone].',
    );

    expect(result).not.toBeNull();
    expect(['WARN', 'DELETE']).toContain(result?.actionBand);
  });

  it('does not hide a military equipment vendor behind fundraiser wording', () => {
    const result = detect(
      'Сбор для бойцов на передовой. Мы изготавливаем квадрокоптеры и помогаем надежному тылу, стоимость комплекта 50000 рублей, звоните [phone].',
    );

    expect(result).not.toBeNull();
    expect(['WARN', 'DELETE']).toContain(result?.actionBand);
  });

  it.each([
    'Сбор для бойцов на передовой. Оказываем услуги по сборке квадрокоптеров и помогаем надежному тылу, стоимость комплекта 50000 рублей, звоните [phone].',
    'Сбор для бойцов на передовой. Компания предоставляет услуги по сборке квадрокоптеров и помогает надежному тылу, стоимость комплекта 50000 рублей, звоните [phone].',
  ])('does not hide an explicit paid service behind frontline fundraiser wording: %s', (text) => {
    const result = detect(text);

    expect(result?.actionBand).toBe('DELETE');
  });

  it.each([
    ['STRICT', 38, 55],
    ['BALANCED', 57, 77],
  ] as const)(
    'keeps frontline fundraiser delivery expenses non-actionable in %s',
    (commercialAdsSensitivity, commercialAdsWarnThreshold, commercialAdsDeleteThreshold) => {
      const result = detect(
        'Сбор средств на помощь бойцам фронта. Собранные деньги пойдут на оплату доставки грузов стоимостью 5000 руб. Звоните координатору [phone].',
        {
          settings: {
            commercialAdsSensitivity,
            commercialAdsWarnThreshold,
            commercialAdsDeleteThreshold,
          },
        },
      );

      expect(result?.actionable ?? false).toBe(false);
    },
  );

  it.each([
    ['STRICT', 38, 55],
    ['BALANCED', 57, 77],
  ] as const)(
    'keeps an explicitly source-owned paid frontline delivery actionable in %s',
    (commercialAdsSensitivity, commercialAdsWarnThreshold, commercialAdsDeleteThreshold) => {
      const result = detect(
        'Сбор средств на помощь бойцам фронта. Мы оказываем платную доставку гуманитарных грузов, стоимость услуги 5000 руб. Закажите доставку [phone].',
        {
          settings: {
            commercialAdsSensitivity,
            commercialAdsWarnThreshold,
            commercialAdsDeleteThreshold,
          },
        },
      );

      expect(result?.actionBand).toBe('WARN');
      expect(result?.actionable).toBe(true);
    },
  );

  it('keeps an offer of humanitarian help inside a frontline fundraiser non-commercial', () => {
    expect(
      detect(
        'Сбор для бойцов на передовой. Оказываем помощь с доставкой гуманитарных грузов, поддерживаем надежный тыл. Любой добровольный взнос можно перевести по реквизитам [card].',
      ),
    ).toBeNull();
  });

  it('keeps company-provided humanitarian help inside a frontline fundraiser non-commercial', () => {
    expect(
      detect(
        'Сбор для бойцов на передовой. Компания предоставляет помощь с доставкой гуманитарных грузов и поддерживает надежный тыл. Перевод по реквизитам [card].',
      ),
    ).toBeNull();
  });

  it('does not confuse a drone assembly vacancy with a fundraiser', () => {
    const result = detect(
      'В добровольческий армейский резерв требуются бойцы: пилоты, инженеры и мастера по сборке и ремонту БПЛА. Контракт 6 месяцев, зарплата от 220000 руб., полный соцпакет. Контакты [url].',
    );

    expect(result?.primarySubtype).toBe('RECRUITMENT');
    expect(['WARN', 'DELETE']).toContain(result?.actionBand);
  });

  it.each([
    [
      'public fundraiser followed by card lead generation',
      'После пожара открыт сбор помощи семье. Банковская карта с бонусом 5000 рублей, оформить по ссылке https://example.com/card.',
      'risk:bank-card-leadgen',
    ],
    [
      'animal adoption followed by a casino landing page',
      'Щенок ищет семью и добрые руки. Онлайн-казино с бонусом, играйте по ссылке https://win4land.com.',
      'risk:casino-landing-link',
    ],
    [
      'fuel report followed by a casino landing page',
      'На АЗС есть АИ-95, очередь небольшая. Онлайн-казино с бонусом, играйте по ссылке https://win4land.com.',
      'risk:casino-landing-link',
    ],
  ])('does not let a benign prefix hide escalation risk: %s', (_label, text, riskSignal) => {
    const result = detect(text);

    expect(result?.matchedSignals).toContain(riskSignal);
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it('does not escalate legitimate diploma requirements or document translation', () => {
    const vacancy = detect(
      'На работу требуется диплом инженера. Поможем быстро адаптироваться, официальное оформление. Вопросы по телефону [phone].',
    );
    const translation = detect(
      'Бюро переводов: перевод документов об образовании быстро, гарантия качества. Пишите по телефону [phone].',
    );

    expect(vacancy?.matchedSignals ?? []).not.toContain('risk:document-service');
    expect(vacancy?.actionBand).not.toBe('DELETE_AND_ESCALATE');
    expect(translation?.matchedSignals ?? []).not.toContain('risk:document-service');
    expect(translation?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    'Пройдите дистанционное обучение 256 часов и получите диплом о переподготовке без посещения учебного центра. Лицензия на сайте https://example.edu/course, запись +7 900 000 40 14.',
    'Получите диплом после онлайн-обучения без посещения очных занятий. Экзамен дистанционно, учебный центр имеет лицензию. Запись +7 900 000 40 15.',
  ])('does not escalate a licensed distance-education program', (text) => {
    const result = detect(text);

    expect(result?.matchedSignals ?? []).not.toContain('risk:document-service');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    'Переплётная мастерская восстановит корочки дипломов и удостоверений, заменит повреждённую обложку. Телефон +7 900 000 40 17.',
    'Изготавливаем корочки и папки для дипломов, сертификатов и аттестатов без печати документов. Телефон +7 900 000 40 18.',
  ])('does not escalate physical credential-cover work', (text) => {
    const result = detect(text);

    expect(result?.matchedSignals ?? []).not.toContain('risk:document-service');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it('respects explicit debunking of pseudomedical replacement claims', () => {
    const result = detect(
      'Биорезонанс не заменяет анализы, МРТ или УЗИ. Медицинский центр рекомендует обследование по назначению врача, запись [phone].',
    );

    expect(result?.matchedSignals ?? []).not.toContain('risk:pseudomedical-diagnostics');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it('requires paid-entry wording for raffle escalation', () => {
    const freeStorePromo = detect(
      'Бесплатный розыгрыш магазина: номер участника выдаётся за покупку от 1000 руб. Победитель получит приз, доплачивать не нужно. [url]',
    );
    const paidRaffle = detect(
      'Разыгрываем телевизор. Стоимость номерка 300 руб. Победителя определит генератор, оплата переводом. [url]',
    );

    expect(freeStorePromo?.matchedSignals ?? []).not.toContain('risk:paid-raffle');
    expect(freeStorePromo?.actionBand).not.toBe('DELETE_AND_ESCALATE');
    expect(paidRaffle?.matchedSignals).toContain('risk:paid-raffle');
    expect(paidRaffle?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    [
      'ticket price',
      'Розыгрыш айфона. Билет 300 руб. Победителя определим генератором, пишите в личку.',
    ],
    [
      'participation price',
      'Разыгрываем телевизор. Участие 300 рублей, оплата переводом. Выигрыш случайному участнику.',
    ],
    [
      'number price',
      'Добро пожаловать в группу розыгрышей призов. Номерки от 30₽, победителя выберет генератор. https://example.com/raffle',
    ],
  ])('escalates a paid raffle with a bare %s', (_label, text) => {
    const result = detect(text);

    expect(result?.matchedSignals).toContain('risk:paid-raffle');
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    'Бесплатный розыгрыш: получите номер участника за покупку от 1000 руб, доплачивать не нужно.',
    'Розыгрыш сертификата на 3000 руб среди подписчиков, участие бесплатное.',
    'Вход на фестиваль по билету за 500 руб. В программе музыка и бесплатный розыгрыш подарков среди всех гостей. Телефон +7 900 000 40 16.',
  ])('does not escalate a free giveaway with a prize value', (text) => {
    const result = detect(text);

    expect(result?.matchedSignals ?? []).not.toContain('risk:paid-raffle');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it('keeps professional vehicle exchange actionable without weakening private barter', () => {
    const buyout = detect(
      'Автосалон: срочный выкуп и обмен автомобилей. Деньги сразу, бесплатная оценка. Телефон +7 900 000 40 02.',
    );

    expect(buyout?.primarySubtype).toBe('BUYOUT');
    expect(buyout?.safeContextBucket).toBe('none');
    expect(buyout?.actionBand).not.toBe('REVIEW_ONLY');
    expect(
      detect('Обменяю свой велосипед на самокат, велосипед б/у, возможен самовывоз.'),
    ).toBeNull();
  });

  it('distinguishes a seller quantity narrative from an explicit buyer order', () => {
    const seller = detect(
      'Мне привезли 20 кг свежей форели. Продаю по 700 руб/кг, доставка по городу, телефон [phone].',
    );

    expect(seller).not.toBeNull();
    expect(seller?.negativeSignals).not.toContain('search-pattern:request:order-or-application');
    expect(seller?.actionBand).toBe('REVIEW_ONLY');
    expect(detect('Оформите мне заказ: 2 кг форели, пожалуйста.')).toBeNull();
  });

  it('distinguishes a Turkic passenger request from a taxi call to action', () => {
    expect(detect('9 остановка до Озерной, такси херек [phone]')).toBeNull();

    const taxi = detect(
      'Такси керек? До аэропорта и вокзала, межгород круглосуточно, звоните +7 900 000 40 08.',
    );
    expect(taxi?.primarySubtype).toBe('SERVICES');
    expect(taxi?.actionBand).toBe('WARN');
  });

  it('does not clear review for a past retail purchase narrative', () => {
    const narrative = detect(
      'В магазине были в наличии новые куртки. Я купила одну за 3000 руб, качество нормальное.',
    );

    expect(narrative?.classifierReasons ?? []).not.toContain('cleared-retail-business-inventory');
    expect(narrative?.actionBand ?? 'ALLOW').toBe('REVIEW_ONLY');
  });

  it('retains bank-card risk when a vacancy embeds an explicit card offer', () => {
    const result = detect(
      'Вакансия на складе, зарплата на карту Альфа-Банка. Карту закажите по ссылке https://example.com/card, после активации бонус 500 руб. Телефон +7 900 000 40 03.',
    );

    expect(result?.matchedSignals).toContain('risk:bank-card-leadgen');
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it.each(['500 ₽', '500 руб'])('retains a bank referral reward written as %s', (reward) => {
    const result = detect(
      `Вакансия на складе, зарплата на карту. Альфа-Банк платит ${reward} при оформлении, https://example.com/card. Телефон +7 900 000 40 25.`,
    );

    expect(result?.matchedSignals).toContain('risk:bank-card-leadgen');
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it('does not mistake a disaster donation card for drop recruitment', () => {
    expect(
      detect(
        'После пожара семья осталась без дома. Открыт сбор помощи, карта для приема переводов указана у волонтера. Телефон +7 900 000 40 26.',
      ),
    ).toBeNull();

    const disguisedRecruitment = detect(
      'После пожара открыт сбор помощи. Нужны карты для приема переводов, оплата владельцу ежедневно, пишите в тг cashwork77.',
    );
    expect(disguisedRecruitment?.matchedSignals).toContain('risk:payment-card-drop-leadgen');
    expect(disguisedRecruitment?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it('does not mistake an animal treatment fundraiser for drop recruitment', () => {
    for (const text of [
      'Щенок ищет дом и добрые руки. Открыт сбор на лечение, карта для приема переводов. По вопросам телефон +7 900 000 40 28.',
      'Ребёнку нужна срочная операция. Открыт сбор средств на лечение, карта для приема переводов. Телефон мамы +7 900 000 40 29.',
      'Помогите семье оплатить лечение. Пожертвования: карта для приёма переводов. Телефон +7 900 000 40 30.',
    ]) {
      const result = detect(text);
      expect(result?.matchedSignals ?? []).not.toContain('risk:payment-card-drop-leadgen');
      expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
    }

    const ordinaryBusinessPayments = detect(
      'Магазин принимает оплату: карта для приема платежей, по вопросам звоните +7 900 000 40 31.',
    );
    expect(ordinaryBusinessPayments?.matchedSignals ?? []).not.toContain(
      'risk:payment-card-drop-leadgen',
    );
  });

  it('does not let free-raffle wording hide a separate paid entry', () => {
    const mixed = detect(
      'У магазина есть бесплатный розыгрыш среди покупателей. Отдельно разыгрываем телефон: участие 300 руб, победителя выберет генератор, доплачивать не нужно. [url]',
    );

    expect(mixed?.matchedSignals).toContain('risk:paid-raffle');
    expect(mixed?.actionBand).toBe('DELETE_AND_ESCALATE');

    const mixedMoneyLot = detect(
      'В магазине бесплатный розыгрыш. А в нашей группе денежный лот: билет 500 руб, оплата на карту. https://example.com/raffle',
    );
    expect(mixedMoneyLot?.matchedSignals).toContain('risk:paid-raffle');
    expect(mixedMoneyLot?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    'Продам диплом государственного образца без обучения, внесение в реестр. Пишите по телефону +7 900 000 40 04.',
    'Диплом без обучения, внесение в официальный реестр. Заказать по телефону +7 900 000 40 05.',
    'Корочки, аттестаты, удостоверения, сертификаты, дипломы и многое другое. Телефон +7 900 000 40 06.',
  ])('escalates an explicit fake credential offer', (text) => {
    const result = detect(text);

    expect(result?.matchedSignals).toContain('risk:document-service');
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it('does not escalate a debunked pseudomedical replacement claim with intervening words', () => {
    const result = detect(
      'Биорезонансная диагностика, по мнению врачей, не может заменять анализы, МРТ или УЗИ. Запись к доказательному терапевту по телефону +7 900 000 40 07.',
    );

    expect(result?.matchedSignals ?? []).not.toContain('risk:pseudomedical-diagnostics');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    'Биорезонанс не выявляет причины аллергии или бесплодия и не показывает состояние органов. Запись к врачу +7 900 000 40 23.',
    'Биорезонанс не избавляет от сдачи анализов и очереди к врачу. Запись к терапевту +7 900 000 40 24.',
    'Биорезонанс не помогает выявить причины аллергии или бесплодия. Запись к врачу +7 900 000 40 33.',
    'Биорезонанс нельзя использовать, чтобы выявлять причины аллергии. Запись к врачу +7 900 000 40 34.',
  ])('does not escalate a locally negated pseudomedical claim', (text) => {
    const result = detect(text);

    expect(result?.matchedSignals ?? []).not.toContain('risk:pseudomedical-diagnostics');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it('keeps independent pseudomedical detection claims risky when replacement is negated', () => {
    const result = detect(
      'Биорезонанс не заменяет анализы, но выявляет причины аллергии и бесплодия, показывает состояние каждого органа. Предварительная запись +7 900 000 40 22.',
    );

    expect(result?.matchedSignals).toContain('risk:pseudomedical-diagnostics');
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');

    const notOnly = detect(
      'Биорезонанс не только выявляет причины аллергии, но и показывает состояние органов. Предварительная запись +7 900 000 40 35.',
    );
    expect(notOnly?.matchedSignals).toContain('risk:pseudomedical-diagnostics');
    expect(notOnly?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    'Хороший электрик Иван, делал нам проводку. Телефон +7 900 000 40 11.',
    'Нам чистила диван мастер Анна, всё понравилось. Химчистка мебели +7 900 000 40 12.',
    'Такси межгород Сергей, вчера довёз нас хорошо. Телефон +7 900 000 40 13.',
  ])('does not enforce a third-party service recommendation', (text) => {
    const result = detect(text);

    expect(result?.actionBand ?? 'ALLOW').toBe('ALLOW');
  });

  it('does not let a self-authored service ad impersonate a recommendation', () => {
    const result = detect(
      'Хороший электрик: работаю сам, выполняю монтаж проводки, выезжаю по городу. Звоните +7 900 000 40 27.',
    );

    expect(result).not.toBeNull();
    expect(result?.actionBand).not.toBe('REVIEW_ONLY');
  });

  it.each([
    'Химчистка мебели. Мастер Иван сделал нам диван, всё отлично. Теперь принимает новые заказы, цена от 2000 руб. Телефон +7 900 000 40 43.',
    'Подрядчик Иван сделал нам ремонт, всё отлично. Сейчас выполняет ремонт квартир под ключ, запись открыта, стоимость от 100000 руб. Телефон +7 900 000 40 44.',
    'Мастер Иван сделал нам ремонт. Теперь принимает новые заказы, цена от 2000 руб.',
    'Подрядчик Иван сделал нам ремонт. Теперь выполняет ремонт квартир. Телефон +7 900 000 40 46.',
  ])('does not let a completed-work narrative hide a current service offer', (text) => {
    const result = detect(text);

    expect(result?.primarySubtype).toBe('SERVICES');
    expect(['WARN', 'DELETE']).toContain(result?.actionBand);
    expect(result?.classifierReasons ?? []).not.toContain(
      'review:third-party-service-recommendation',
    );
  });

  it('keeps a priced completed-work recommendation non-commercial without a current offer', () => {
    expect(
      detect(
        'Мастер Иван сделал нам диван за 2000 руб, всё отлично. Рекомендую, звоните ему +7 900 000 40 45.',
      ),
    ).toBeNull();
  });

  it('keeps the coarse commercial precheck aligned with the animal-rescue suppressor', () => {
    const text =
      'Питомник-приют спас щенков. Щенки привиты и ищут добрые семьи, отдаём бесплатно. Телефон волонтёра +7 900 000 40 32.';

    expect(detect(text)).toBeNull();
    expect(detector.hasCommercialSpamMarkers(text)).toBe(false);
  });

  it('escalates a paid raffle whose mandatory entry fee has no numeric price', () => {
    const result = detect(
      'Розыгрыш смартфона. Участие платное, обязательный взнос. Победителя выберет генератор. Подробности [url].',
    );

    expect(result?.matchedSignals).toContain('risk:paid-raffle');
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it('does not attach paid event admission to a separate free raffle', () => {
    const result = detect(
      'Вход на фестиваль платный, билет 500 рублей. В программе музыка и бесплатный розыгрыш подарков среди гостей. Телефон +7 900 000 40 36.',
    );

    expect(result?.matchedSignals ?? []).not.toContain('risk:paid-raffle');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    'Обменник валют: доллар покупка 79, продажа 81. Работаем ежедневно, телефон +7 900 000 40 37.',
    'Обмен валют: доллар покупка 79, продажа 81. Офис в центре, телефон +7 900 000 40 38.',
  ])('detects a professional currency exchange without property-sale noise', (text) => {
    const result = detect(text);

    expect(result?.primarySubtype).toBe('SERVICES');
    expect(result?.matchedSignals).toContain('service-specialty:currency-exchange-service');
    expect(result?.matchedSignals).not.toContain('property-commercial:commercial-space');
    expect(['WARN', 'DELETE']).toContain(result?.actionBand);
  });

  it('keeps a private first-person currency exchange out of enforcement', () => {
    const result = detect('Обменяю 100 долларов на рубли по курсу, пишите в личку.');

    expect(result?.negativeSignals ?? []).toContain('private:обмен');
    expect(['ALLOW', 'REVIEW_ONLY']).toContain(result?.actionBand ?? 'ALLOW');
  });

  it('requires a real response path for the paid esoteric signal and never escalates it', () => {
    const narrative = detect('Таролог рассказывает о значении карт и истории обрядов.');
    const priceOnly = detect('Таролог описала расклад карт в статье, стоимость колоды 1500 руб.');
    const offer = detect('Таролог, расклад 1500 руб. Запись в WhatsApp +7 900 000 40 39.');

    expect(narrative?.matchedSignals ?? []).not.toContain('risk:paid-esoteric-service');
    expect(priceOnly?.matchedSignals ?? []).not.toContain('risk:paid-esoteric-service');
    expect(offer?.matchedSignals).toContain('risk:paid-esoteric-service');
    expect(offer?.hasEscalationRiskEvidence).toBe(false);
    expect(offer?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    [
      'Я таксист, работаю по городу и межгороду, готов отвезти пассажиров.',
      'service-specialty:taxi-driver-self-offer',
    ],
    ['Печатаю детали и макеты на 3D-принтере под заказ.', 'service-specialty:custom-3d-printing'],
    [
      'Сдаю в аренду надувной батут для детских праздников.',
      'service-specialty:inflatable-trampoline-rental',
    ],
    [
      'Пеку имбирные пряники на заказ по вашему дизайну.',
      'service-specialty:custom-gingerbread-order',
    ],
    ['Такси 3303 на линии.', 'service-specialty:taxi-callsign-availability'],
    ['Такси 742 свободен.', 'service-specialty:taxi-callsign-availability'],
  ])('detects an unmistakable object-specific first-person offer: %s', (text, signal) => {
    const result = detect(text);

    expect(result?.primarySubtype).toBe('SERVICES');
    expect(result?.matchedSignals).toContain(signal);
    expect(result?.matchedSignals.some((signal) => signal.startsWith('transaction:'))).toBe(true);
    expect(['WARN', 'DELETE']).toContain(result?.actionBand);
  });

  it.each<{
    label: string;
    settings: Partial<ChatSettings>;
    commercialCampaignContext: CommercialCampaignContext;
  }>([
    {
      label: 'balanced singleton at 49/69',
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 49,
        commercialAdsDeleteThreshold: 69,
      },
      commercialCampaignContext: {
        senderDistinctChatCount: 1,
        sameTextDistinctChatCount: 1,
        repeatedPhoneDistinctChatCount: 0,
        repeatedLinkDistinctChatCount: 0,
        nearTextDistinctChatCount: 1,
        repeatedDomainDistinctChatCount: 0,
        repeatedHandleDistinctChatCount: 0,
        senderDistinctChatCount5m: 1,
        senderDistinctChatCount30m: 1,
        senderDistinctChatCount120m: 1,
      },
    },
    {
      label: 'balanced standard campaign at 45/65',
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 45,
        commercialAdsDeleteThreshold: 65,
      },
      commercialCampaignContext: {
        senderDistinctChatCount: 2,
        sameTextDistinctChatCount: 2,
        repeatedPhoneDistinctChatCount: 0,
        repeatedLinkDistinctChatCount: 0,
        nearTextDistinctChatCount: 2,
        repeatedDomainDistinctChatCount: 0,
        repeatedHandleDistinctChatCount: 0,
        senderDistinctChatCount5m: 2,
        senderDistinctChatCount30m: 2,
        senderDistinctChatCount120m: 2,
      },
    },
    {
      label: 'balanced strong campaign at 49/69',
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 49,
        commercialAdsDeleteThreshold: 69,
      },
      commercialCampaignContext: {
        senderDistinctChatCount: 3,
        sameTextDistinctChatCount: 3,
        repeatedPhoneDistinctChatCount: 0,
        repeatedLinkDistinctChatCount: 0,
        nearTextDistinctChatCount: 3,
        repeatedDomainDistinctChatCount: 0,
        repeatedHandleDistinctChatCount: 0,
        senderDistinctChatCount5m: 1,
        senderDistinctChatCount30m: 3,
        senderDistinctChatCount120m: 3,
      },
    },
    {
      label: 'strict strong campaign at 40/58',
      settings: {
        commercialAdsSensitivity: 'STRICT',
        commercialAdsWarnThreshold: 40,
        commercialAdsDeleteThreshold: 58,
      },
      commercialCampaignContext: {
        senderDistinctChatCount: 4,
        sameTextDistinctChatCount: 4,
        repeatedPhoneDistinctChatCount: 0,
        repeatedLinkDistinctChatCount: 0,
        nearTextDistinctChatCount: 4,
        repeatedDomainDistinctChatCount: 0,
        repeatedHandleDistinctChatCount: 0,
        senderDistinctChatCount5m: 1,
        senderDistinctChatCount30m: 4,
        senderDistinctChatCount120m: 4,
      },
    },
  ])('keeps a deal-less ribbon bouquet showcase review-only: $label', (testCase) => {
    const result = detect(
      'Предлагаю эксклюзивные букеты из атласных лент, созданные с душой и вниманием к каждой детали. Никогда не завянут. Вы сами выбираете цвет и количество цветов. Качественно, красиво и быстро.',
      testCase,
    );

    expect(result?.matchedSignals).toContain('service-specialty:custom-ribbon-bouquet');
    expect(result?.actionBand).toBe('REVIEW_ONLY');
    expect(result?.actionable).toBe(false);
    expect(result?.reviewReasons).toContain('handmade-showcase-without-direct-deal');
  });

  it('allows direct deal evidence to clear the ribbon bouquet review cap', () => {
    const result = detect(
      'Предлагаю эксклюзивные букеты из атласных лент, вы выбираете цвет и количество цветов. Цена 2500 руб., заказать по телефону +7 900 000 40 60.',
    );

    expect(result?.matchedSignals).toEqual(
      expect.arrayContaining([
        'service-specialty:custom-ribbon-bouquet',
        'transaction:price',
        'contact:phone',
      ]),
    );
    expect(result?.reviewReasons).not.toContain('handmade-showcase-without-direct-deal');
    expect(['WARN', 'DELETE']).toContain(result?.actionBand);
  });

  it.each([
    'Еду до центра, ищу попутчиков. Такси 3303 на линии приложения.',
    'Такси 7 на линии.',
    'Такси 12 свободен.',
    'Такси 12345 на линии.',
    'Обсуждаем печать деталей на 3D-принтере в школьном кружке.',
    'Продам надувной батут, б/у после одного праздника, цена 5000 руб.',
    'В библиотеке пройдёт бесплатный мастер-класс: печём имбирные пряники.',
    'В рассказе героиня получила букет из атласных лент.',
  ])('does not broaden an object-specific offer rule to a neighboring non-offer', (text) => {
    const result = detect(text);

    expect(result?.matchedSignals ?? []).not.toEqual(
      expect.arrayContaining([
        'service-specialty:taxi-callsign-availability',
        'service-specialty:custom-3d-printing',
        'service-specialty:inflatable-trampoline-rental',
        'service-specialty:custom-gingerbread-order',
        'service-specialty:custom-ribbon-bouquet',
      ]),
    );
    expect(['ALLOW', 'REVIEW_ONLY']).toContain(result?.actionBand ?? 'ALLOW');
  });

  it('does not treat the word Новостройка as news morphology', () => {
    const result = detect(
      'Подписывайтесь на канал Новостройка: квартиры от застройщика со скидкой, звоните +7 900 000 40 40. [url]',
    );

    expect(result).not.toBeNull();
    expect(result?.negativeSignals).not.toContain('context:local-news-subscribe');
    expect(result?.safeContextBucket).not.toBe('news_or_analytics');
  });

  it.each([
    'Оформление медицинской справки без очереди, доставка курьером. Телефон +7 900 000 40 52.',
    'Получите водительские права после обучения в автошколе и сдачи экзамена. Запись +7 900 000 40 53.',
  ])('requires an explicit illicit anchor before escalating a document service', (text) => {
    const result = detect(text);

    expect(result?.matchedSignals ?? []).not.toContain('risk:document-service');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    'В рекламе клиники утверждают, что биорезонанс заменяет анализы и выявляет причины аллергии. Не верьте: это вводит в заблуждение. Телефон из рекламы +7 900 000 40 54.',
    'Шарлатаны якобы выявляют биорезонансом причины аллергии и бесплодия. Врачи предупреждают, что метод этого не делает. Телефон из объявления +7 900 000 40 55.',
  ])('does not escalate an attributed or debunked pseudomedical claim', (text) => {
    const result = detect(text);

    expect(result?.matchedSignals ?? []).not.toContain('risk:pseudomedical-diagnostics');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    'В договоре указан телефон подрядчика по ремонту +7 900 000 40 56.',
    'В акте указан подрядчик ООО Ремонт, телефон +7 900 000 40 57.',
    'По протоколу выбран подрядчик на ремонт, телефон диспетчера +7 900 000 40 58.',
    'Управляющая компания сообщила телефон диспетчера подрядчика +7 900 000 40 59.',
    'Подрядчик завершил ремонт дома, работы приняты по акту. Телефон указан в документе +7 900 000 40 60.',
  ])('does not enforce a contractor reference or completed-work narrative', (text) => {
    const result = detect(text);

    expect(result?.actionBand ?? 'ALLOW').toBe('ALLOW');
  });

  it.each([
    'Продам стол складной туристический с органайзером (подстольное хранение). Складывается в сумку. Размер в разложенном виде 60*120, цена 3 тр.',
    'Продам диван раскладной. Б/у в нормальном состоянии. Самовывоз. Цена 5000 р. Незлобная',
    'Продам классические брюки (в школу, в офис). Красивый серый цвет, в полоску. Размер 40-42, лучше ориентироваться на замеры. Длина изделия 105 см, ширина штанины 26 см. Цена 350 руб',
    'Продам комбинезон с капюшоном для собак и кошек мелких и средних пород. Размер L, цена 400 руб',
  ])('keeps an exact replay one-off private sale out of enforcement', (text) => {
    const result = detect(text);

    expect(result?.matchedSignals ?? []).not.toContain('property-commercial:commercial-space');
    expect(result?.matchedSignals ?? []).not.toContain('risk:paid-esoteric-service');
    expect(['ALLOW', 'REVIEW_ONLY']).toContain(result?.actionBand ?? 'ALLOW');
  });

  it.each([
    [
      'expanded spam disclaimer',
      'Это не является спамом. Платим 3500 ₽ за отзыв на Wildberries, ежедневные задания. Пишите в Telegram https://example.com/work.',
      'risk:paid-review-task',
    ],
    [
      'no-complaints casino claim',
      'Онлайн-казино с быстрыми выплатами, жалоб нет. Бонус 5000, играйте https://win4land.com.',
      'risk:casino-landing-link',
    ],
    [
      'police non-blocking crypto claim',
      'Криптоинвестиции: пассивный доход, полиция не блокирует, жалоб нет. Начать по ссылке https://example.com/crypto.',
      'risk:crypto-investment',
    ],
    [
      'bank offer disguised as a review',
      'Мой отзыв об Альфа-Банке: банк дарит 500 ₽ за оформление карты. Получить по ссылке https://example.com/card.',
      'risk:bank-card-leadgen',
    ],
    [
      'bank offer disguised as a question',
      'Подскажите по банку: дарим бонус за оформление карты https://example.com/card.',
      'risk:bank-card-leadgen',
    ],
  ])('does not let soft safe-context wording hide escalation risk: %s', (_label, text, risk) => {
    const result = detect(text);

    expect(result?.matchedSignals).toContain(risk);
    expect(result?.safeContextBucket).toBe('none');
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    [
      'natural 3D-printing offer',
      'Занимаюсь 3D-печатью: делаю фигурки и полезные вещи для дома. Посмотреть работы и заказать можно в профиле, пишите в ЛС.',
      'service-specialty:custom-3d-printing',
    ],
    [
      'address-sign price list',
      'Изготовление адресных табличек. Отправка по всей России, по запросу отправляем прайс.',
      'service-specialty:address-sign-service',
    ],
    [
      'local mowing offer',
      'Скашу траву триммером по Сергиевску.',
      'service-specialty:local-mowing-self-offer',
    ],
    [
      'packaged custom song',
      'Создам песню на любой праздник: рождение ребёнка, свадьба, годовщина или выпускной. Готовность 1-2 часа, два варианта.',
      'service-specialty:custom-song-package',
    ],
    [
      'natural inflatable rental',
      'Аренда больших надувных батутов: привезём на весь день по бюджетной цене, без предоплаты. Бронируйте заранее.',
      'service-specialty:inflatable-trampoline-rental',
    ],
    [
      'seasonal gingerbread preorder',
      'Принимаю заказы на штучные пряники и пряничные наборы к 1 сентября. Много макетов для печати.',
      'service-specialty:custom-gingerbread-order',
    ],
  ])('detects a narrowly structured manual-review service: %s', (_label, text, signal) => {
    const result = detect(text);

    expect(result?.primarySubtype).toBe('SERVICES');
    expect(result?.matchedSignals).toContain(signal);
    expect(result?.matchedSignals).toContain('transaction:structured-service-offer');
    expect(['WARN', 'DELETE']).toContain(result?.actionBand);
  });

  it.each([
    [
      'memorial video',
      'Создам трогательный ролик в память о герое, дань уважения близкому. Чтобы заказать видео, пишите в личные сообщения или звоните [phone].',
      'service-specialty:memorial-video-service',
    ],
    [
      'forged flower production',
      'Кованая роза, цена 700 рублей за штуку. Могу изготовить букеты в любом количестве, по вопросам пишите в ЛС.',
      'service-specialty:custom-forged-flower',
    ],
    [
      'wedding car decoration rental',
      'Прокат и продажа свадебных украшений на авто, по всем вопросам обращаться в ЛС.',
      'service-specialty:wedding-decoration-rental',
    ],
    [
      'organized author tour',
      'Авторский тур в Дагестан на 3 дня. Стоимость 12500 руб, проезд, проживание и гид включены. Осталось 6 мест, бронируйте по телефону [phone].',
      'service-specialty:organized-tour-service',
    ],
    [
      'website package',
      'Создаем сайты на Тильде: одностраничный 19000 руб, многостраничный 22000 руб. Для бизнеса, пишите в WhatsApp [phone].',
      'service-specialty:website-creation-service',
    ],
  ])('enforces a direct object-specific service: %s', (_label, text, signal) => {
    const result = detect(text);

    expect(result?.primarySubtype).toBe('SERVICES');
    expect(result?.matchedSignals).toContain(signal);
    expect(['WARN', 'DELETE']).toContain(result?.actionBand);
  });

  it('caps the audited website package at WARN without weakening independent evidence', () => {
    const websiteOffer =
      'Создаем сайты на Тильде: одностраничный 19000 руб, многостраничный 22000 руб. Для бизнеса, пишите в WhatsApp [phone].';
    const propertyOffer =
      'Агентство недвижимости: ЖК Флора, студия 24 м2 за 3.450.000 руб, квартира 32 м2 за 4.250.000 руб. Звоните [phone].';
    const websiteOnly = detect(websiteOffer);
    const combined = detect(`${websiteOffer} ${propertyOffer}`);
    const escalated = detect(
      `${websiteOffer} Деньги до зарплаты онлайн, одобрим без отказа, hxxp://credit dot ru`,
    );

    expect(websiteOnly?.matchedSignals).toContain('service-specialty:website-creation-service');
    expect(websiteOnly?.actionBand).toBe('WARN');
    expect(websiteOnly?.suppressionReasons).toContain('conservative-recall-warn-cap');
    expect(combined?.actionBand).toBe('DELETE');
    expect(combined?.suppressionReasons).not.toContain('conservative-recall-warn-cap');
    expect(escalated?.actionBand).toBe('DELETE_AND_ESCALATE');
    expect(escalated?.suppressionReasons).not.toContain('conservative-recall-warn-cap');
  });

  it('keeps a plural own-production 3D catalog separate from a private single item', () => {
    const retail = detect(
      'Продам 3д игрушки собственного производства, кому интересно пишите в ЛС.',
    );

    expect(retail?.primarySubtype).toBe('GOODS_RETAIL');
    expect(retail?.matchedSignals).toContain('goods-retail:own-3d-product-retail');
    expect(['WARN', 'DELETE']).toContain(retail?.actionBand);
    expect(
      detect('Продам одну 3д игрушку, ребёнок больше не играет. Самовывоз, цена 500 руб.'),
    ).toBeNull();
  });

  it('detects a numbered group-directory promotion without broadening a news footer', () => {
    const directory = detect(
      'Подписывайся разом в 164 группы: папка 100 групп https://example.com/a, папка 64 группы https://example.com/b.',
    );

    expect(directory?.matchedSignals).toContain(
      'channel-placement:numbered-group-directory-subscribe',
    );
    expect(['WARN', 'DELETE']).toContain(directory?.actionBand);
    expect(
      detect('Новости района за день. Подписывайтесь на канал администрации: [url].')?.actionBand ??
        'ALLOW',
    ).toBe('ALLOW');
  });

  it.each([
    'Победитель конкурса рисунков получит приз. Организационный взнос 500 рублей. Регистрация по телефону [phone].',
    'Победитель городского забега получит кубок. Участие 500 рублей, запись по телефону [phone].',
    'Победитель викторины получит приз. Билет 300 рублей, регистрация [url].',
    'Победитель конкурса определяется открытым голосованием жюри. Вход 500 рублей, материалы включены.',
  ])('does not turn an ordinary paid contest into a chance-based raffle', (text) => {
    const result = detect(text);

    expect(result?.matchedSignals ?? []).not.toContain('risk:paid-raffle');
    expect(result?.matchedSignals ?? []).not.toContain('risk:paid-raffle-transfer');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    'ЛОТ С ПОВТОРОМ 150. ПЕРЕВОД на +7 900 000 41 01, Тбанк. Всем желаем удачи.',
    'Л𝐎𝐓 𝐂 П𝐎𝐁𝐓𝐎𝐏𝐎𝐌: 3️⃣0️⃣0️⃣₽ номерок. Перевод на +7 900 000 41 02, Тбанк.',
    'Всем добро пожаловать в группу розыгрышей. Номерки не дорогие от 50₽ и выше. https://example.com/raffle',
    'Я разыгрываю призы с Ozon. Лоты у нас от 45 до 200 руб, победителей выберем случайно. https://example.com/raffle',
    'Добро пожаловать в денежную группу. Лоты от 1⃣3⃣5⃣ и выше, копилка и баланс. https://example.com/raffle',
    'Лоты с повтором, генератор рандомус. При проигрыше стоимость номерка возвращается на баланс. https://example.com/raffle',
  ])('escalates a manually confirmed paid-lot variant', (text) => {
    const result = detect(text);

    expect(result?.matchedSignals.some((signal) => signal.startsWith('risk:paid-raffle'))).toBe(
      true,
    );
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it('keeps non-offer neighbors outside the new narrow service rules', () => {
    for (const text of [
      'В школьном кружке занимаюсь 3D-печатью и показываю учебные работы.',
      'Администрация обсудила изготовление адресных табличек на заседании.',
      'Завтра скашу траву триммером по дороге к дому.',
      'В статье разбирают, как создать песню к свадьбе и годовщине.',
      'Продам надувной батут, один, б/у после праздника, цена 5000 руб.',
      'В библиотеке принимают заявки на мастер-класс: пряничные наборы к 1 сентября.',
    ]) {
      expect(['ALLOW', 'REVIEW_ONLY']).toContain(detect(text)?.actionBand ?? 'ALLOW');
    }
  });

  it.each([
    [
      'courier vacancy',
      'Срочно требуется курьер в Яндекс Еду. Доход от 5000 руб в день, удобные смены. Звони прямо сейчас [phone] или регистрируйся по ссылке [url].',
      'DELETE',
    ],
    [
      'paid mass placement',
      'Вашу рекламу ставим в тысячи досок и чатов VK/MAX за 5000 руб в месяц. ВК: [url]',
      'DELETE',
    ],
    [
      'paid marketplace reviews',
      'Компания Ozon набирает модераторов отзывов. Оплата 2000-3200 руб ежедневно. Напишите менеджеру ВКонтакте: [url]',
      'DELETE_AND_ESCALATE',
    ],
    [
      'packaged tour with sanitized price',
      'Тур в Дагестан на три дня: трансфер, проживание, питание, гид и билеты включены. Цена [phone] ₽. Запись: [phone].',
      'DELETE',
    ],
    [
      'retail item with sanitized price and contact',
      'В наличии электроскутер. Аккумулятор 48v, запас хода 30 км. Цена [phone]р. Доставка до адреса в подарок. [phone] Алена',
      'DELETE',
    ],
    [
      'dentist price list',
      'Стоматолог: все виды услуг. Пломба 1500 руб, лечение 2500 руб, чистка 3000 руб. Ватсап группа: [url]',
      'DELETE',
    ],
    [
      'massage campaign',
      'Приглашаем на лечебный массаж и хиджаму. До конца мая акция для клиентов. Телефон: [phone]. Ватсап: [url]',
      'DELETE',
    ],
  ])('uses a contextual sanitized placeholder for a clear %s', (_label, text, action) => {
    const result = detect(text);

    expect(result?.actionBand).toBe(action);
    expect(detector.hasCommercialSpamMarkers(text)).toBe(true);
  });

  it.each([
    'На завтра принимаем заказы на мясо домашней свинки. Лопатка 500 руб/кг, рёбра 500 руб/кг, шея 550 руб/кг, корейка 400 руб/кг. Обращайтесь по телефону [phone]. Бесплатная доставка.',
    'Доставка курочек породы Ломан Браун возрастом 5 месяцев, начинают нестись. Цена 500 руб за голову, запись по телефону [phone].',
  ])('deletes a professional local-food order catalog', (text) => {
    const result = detect(text);

    expect(result?.primarySubtype).toBe('GOODS_RETAIL');
    expect(result?.matchedSignals).toContain('goods-retail:professional-order-catalog');
    expect(result?.safeContextBucket).toBe('none');
    expect(result?.actionBand).toBe('DELETE');
  });

  it.each([
    [
      'Доброго времени суток. Рабочая бригада: спил деревьев, вывоз мусора, очистка дворов и сараев, покраска заборов. Все виды работ. Тел [phone].',
      'SERVICES',
    ],
    [
      'Баня под ключ. Хотите собственную баню без лишних хлопот? Мы предлагаем готовое решение: фундамент, сруб, крыша, полы и полная сборка. Заказывайте.',
      'GOODS_RETAIL',
    ],
    [
      'Сдаю бюджетное жильё на Ольхоне в Хужире. Домики, столовая на территории, уличный душ и мангал. [phone]',
      'SERVICES',
    ],
  ] as const)(
    'keeps an unmistakable structured offer actionable after sanitization',
    (text, expectedSubtype) => {
      const result = detect(text);

      expect(result?.primarySubtype).toBe(expectedSubtype);
      expect(['WARN', 'DELETE']).toContain(result?.actionBand);
    },
  );

  it('keeps on-site sauna construction as a service without ready-made inventory', () => {
    const result = detect(
      'Баню под ключ строим на вашем участке: фундамент, сруб, кровля. Полная сборка на месте, выезд и замер. Звоните [phone].',
    );

    expect(result?.matchedSignals).toContain('service-specialty:sauna-under-key-service');
    expect(result?.matchedSignals).not.toContain('goods-retail:inventory');
    expect(result?.primarySubtype).toBe('SERVICES');
  });

  it.each([
    'Продам диван 10000 руб, доставка. Все вопросы по телефону [phone].',
    'Продам два матраса для плавания, новые в упаковке. Цена 2000 руб каждый, при покупке обоих скидка. [phone]',
    'Водитель 29.05.26 Аскиз - Абакан и обратно, выезд в 8:30, звоните [phone], есть одно место.',
    'Едем в Казань завтра, цена 2000 руб, осталось два места, телефон +7 900 000 40 49.',
    'Продам одного щенка, привит, цена 15000 руб. Возможна доставка по городу. Телефон +7 900 000 40 50.',
  ])('does not enforce an ambiguous private listing with sanitized contacts', (text) => {
    expect(['ALLOW', 'REVIEW_ONLY']).toContain(detect(text)?.actionBand ?? 'ALLOW');
  });

  it('scopes third-party recommendation suppression to service-only messages', () => {
    const property = detect(
      'Агентство продаёт коммерческое помещение 120 м2, цена 12 млн руб. Звоните +7 900 000 40 51. Ремонт сделали нам хорошие мастера.',
    );
    const availableMaster = detect(
      'Мастер Иван сделал нам ремонт. Сейчас свободен, есть свободные окна. Телефон [phone].',
    );

    expect(['PROPERTY_AGENT', 'PROPERTY_COMMERCIAL']).toContain(property?.primarySubtype);
    expect(['WARN', 'DELETE']).toContain(property?.actionBand);
    expect(availableMaster?.primarySubtype).toBe('SERVICES');
    expect(['WARN', 'DELETE']).toContain(availableMaster?.actionBand);
  });

  it.each([
    {
      hash: 'c314d82fd307',
      text: 'Водитель 22.07.26 ст.АСКИЗ-АСКИЗ-АБАКАН и обратно С МЕСТА ДО МЕСТА выезд со станции 6.30 + 30мин. звоните [phone] есть 1 место',
      signal: 'service-specialty:scheduled-round-trip-door-to-door',
      warnThreshold: 45,
      deleteThreshold: 65,
    },
    {
      hash: 'd0020955ba77',
      text: 'Поездки( по предварительному заказу) в Самару, Курумоч и др. Города области и дальше. Встреча с аэропорта. Ж/вокзала удобное для вас время на комфортабельном автомобиле. Т [phone]',
      signal: 'service-specialty:advance-airport-station-transfer',
      warnThreshold: 45,
      deleteThreshold: 65,
    },
    {
      hash: 'd1d1b610befd',
      text: 'САМОЕ БЛИЖАЙШЕЕ ВРЕМЯ Водитель 22.07.26 ст.АСКИЗ-АСКИЗ-АБАКАН и обратно С МЕСТА ДО МЕСТА выезд со станции 6.30 + 30мин. звоните [phone] есть 1 место',
      signal: 'service-specialty:scheduled-round-trip-door-to-door',
      warnThreshold: 45,
      deleteThreshold: 65,
    },
    {
      hash: 'e11d584facd7',
      text: 'Таксую [phone] .',
      signal: 'service-specialty:taxiing-contact-self-offer',
      warnThreshold: 45,
      deleteThreshold: 65,
    },
    {
      hash: 'e7f7f1ce3703',
      text: 'Водитель 24 июля. 07:30 АСКИЗ 09:00 АБАКАН КРАСНОЯРСК Возьму пассажиров, посылки. Обратно 24 июля Выезд в 16:00 КРАСНОЯРСК- АБАКАН- АСКИЗ [phone]',
      signal: 'service-specialty:scheduled-round-trip-parcel-route',
      warnThreshold: 45,
      deleteThreshold: 65,
    },
    {
      hash: 'f045f660447c',
      text: 'Таксую [phone]',
      signal: 'service-specialty:taxiing-contact-self-offer',
      warnThreshold: 45,
      deleteThreshold: 65,
    },
    {
      hash: 'f530242edc17',
      text: '📌📌📌 Сегодня 23 -ое Июля (ЧТ) нужны пассажиры из КЫЗЫЛА в КРАСНОЯРСКА на 7-ми местной иномарка довезу до АЭРОПОРТА ЖД, 2 кондиционера ❄️ Беру посылки 📦 Есть билет QR-код ☎️ [phone] ☎️ [phone]',
      signal: 'service-specialty:professional-passenger-parcel-transfer',
      warnThreshold: 47,
      deleteThreshold: 67,
    },
    {
      hash: 'f5e4c9346249',
      text: 'САМОЕ БЛИЖАЙШЕЕ ВРЕМЯ Водитель 22.07.26 ст.АСКИЗ-АСКИЗ-(можно с Новостройки) - АБАКАН и обратно С МЕСТА ДО МЕСТА выезд со станции 14.30 -/+ 30мин. звоните [phone] есть 1 место ЕДЕМ СРАЗУ',
      signal: 'service-specialty:scheduled-round-trip-door-to-door',
      warnThreshold: 45,
      deleteThreshold: 65,
    },
  ])('warns for manually adjudicated transport service $hash', (entry) => {
    const result = detect(entry.text, {
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: entry.warnThreshold,
        commercialAdsDeleteThreshold: entry.deleteThreshold,
      },
    });

    expect(result?.primarySubtype).toBe('SERVICES');
    expect(result?.matchedSignals).toContain(entry.signal);
    expect(result?.matchedSignals.some((signal) => signal.startsWith('risk:'))).toBe(false);
    expect(result?.actionBand).toBe('WARN');
    expect(result?.suppressionReasons).toContain('structured-transport-warn-cap');
  });

  it('warns for the manually adjudicated strict round-trip parcel service cf3a4bb25036', () => {
    const result = detect(
      '22 07. Четверг Еду в С А М А Р У из Ивантеевки В 9 00 -- 10 00 Из Самары до Ивантеевки 14 30 - 15 00 Е С Т Ь----места Передам посылки документы Тел [phone]',
      {
        settings: {
          commercialAdsSensitivity: 'STRICT',
          commercialAdsWarnThreshold: 38,
          commercialAdsDeleteThreshold: 55,
        },
      },
    );

    expect(result?.primarySubtype).toBe('SERVICES');
    expect(result?.matchedSignals).toContain('service-specialty:scheduled-round-trip-parcel-route');
    expect(result?.matchedSignals.some((signal) => signal.startsWith('risk:'))).toBe(false);
    expect(result?.actionBand).toBe('WARN');
    expect(result?.suppressionReasons).toContain('structured-transport-warn-cap');
  });

  it('caps a high-scoring priced structured transfer at warn', () => {
    const result = detect(
      'Поездки по предварительному заказу в Самару и Курумоч. Встреча с аэропорта на комфортабельном автомобиле. Стоимость поездки 5000 руб. Телефон [phone].',
    );

    expect(result?.matchedSignals).toContain('service-specialty:advance-airport-station-transfer');
    expect(result?.matchedSignals).toContain('transaction:price');
    expect(result?.actionBand).toBe('WARN');
    expect(result?.suppressionReasons).toContain('structured-transport-warn-cap');
  });

  it('keeps independent escalation risk above the structured transport warn cap', () => {
    const result = detect(
      'Таксую. Оформление водительских прав без экзаменов и автошколы. Документы в официальной базе. Заказать [phone]',
    );

    expect(result?.matchedSignals).toContain('service-specialty:taxiing-contact-self-offer');
    expect(result?.matchedSignals).toContain('risk:document-service');
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
    expect(result?.suppressionReasons).not.toContain('structured-transport-warn-cap');
  });

  it('does not let a transport clause weaken an independently deletable retail ad', () => {
    const retail =
      'В магазине Игрушки в наличии новые конструкторы, цена от 900 руб. Оформите заказ по ссылке [url].';
    const combined = detect(
      `Поездки по предварительному заказу в Самару. Встреча с аэропорта. Телефон [phone]. ${retail}`,
    );

    expect(detect(retail)?.actionBand).toBe('DELETE');
    expect(combined?.matchedSignals).toContain(
      'service-specialty:advance-airport-station-transfer',
    );
    expect(combined?.matchedSignals).toContain('goods-retail:inventory');
    expect(combined?.actionBand).toBe('DELETE');
    expect(combined?.suppressionReasons).not.toContain('structured-transport-warn-cap');
  });

  it.each([
    {
      hash: 'ffff58ba84d0',
      text: 'Завтра утром еду до Тюмени в 8:30, есть 1место и обратно около 11:00±, есть также место. [phone]',
      signal: 'review-only:transport-single-date-schedule',
    },
    {
      hash: 'd73cfc661569',
      text: 'Водитель Абакан Аскиз Новостройка В ближайшее время С места до места [phone]',
      signal: 'review-only:transport-door-to-door-operator',
    },
    {
      hash: 'd9adc7b5de06',
      text: '23.07 в 14.00 еду Самара-Суходол от Ж/д вокзала, через ЦАВ 4 места Цена 700 Т. [phone]',
      signal: 'review-only:transport-single-date-schedule',
    },
    {
      hash: 'f1913193d847',
      text: 'Сегодня 23.07.26г еду -Бакалы-Уфа в 14.00-15.00.ч есть места,, округ Галле [phone] +Аэропорт+ЖД',
      signal: 'review-only:transport-airport-station-waypoint',
    },
    {
      hash: 'e41d6e503619',
      text: 'Водитель аскиз-абакан-черногорск В ближайшее время [phone] С места до места',
      signal: 'review-only:transport-door-to-door-operator',
    },
    {
      hash: 'e9370af3f7e3',
      text: 'Водитель ст.аскиз-аскиз-абакан-черногорск 7.00 С аскиза 7.30 [phone] С места до места',
      signal: 'review-only:transport-door-to-door-operator',
    },
    {
      hash: 'd3d583b7e7e8',
      text: 'Водитель завтра Абакан Таштып в 11-11:30 с места до места звоните пишите [phone]',
      signal: 'review-only:transport-door-to-door-operator',
    },
    {
      hash: 'f19b5ba3258e',
      text: 'САМОЕ БЛИЖАЙШЕЕ ВРЕМЯ Водитель АБАКАН-АСКИЗ-ст.АСКИЗ (можно Новостройка) С МЕСТА ДО МЕСТА выезд 17.30 -/+ 30мин звоните [phone] есть 1 место',
      signal: 'review-only:transport-door-to-door-operator',
    },
    {
      hash: 'd079d4290925',
      text: 'Сегодня 22.07.26г еду УФа -ЖД-Бакалы в 23.00 - 00.30ч есть места,, округ Галле [phone] Аэропорт',
      signal: 'review-only:transport-airport-station-waypoint',
    },
    {
      hash: 'fe8dd21be4d5',
      text: 'Водитель АБАКАН-АСКИЗ-ст.АСКИЗ (можно Новостройка) С МЕСТА ДО МЕСТА выезд 17.30 -/+ 30мин звоните [phone] есть 1 место',
      signal: 'review-only:transport-door-to-door-operator',
    },
    {
      hash: 'f8ce6215e0a4',
      text: '23.07 Еду Аромашево Тюмень в 15.30 и обратно Тюмень Аромашево в 19.00 тел [phone]',
      signal: 'review-only:transport-single-date-schedule',
    },
    {
      hash: 'be7856ff8466',
      text: 'Водитель Таштып Абакан с места до места в 15:00 [phone] 2 места',
      signal: 'review-only:transport-door-to-door-operator',
    },
    {
      hash: 'caf79af70ff7',
      text: 'Водитель Абакан-аскиз-ст. аскиза 11.40-12.00 [phone] С места до места',
      signal: 'review-only:transport-door-to-door-operator',
    },
    {
      hash: 'e62e277d7636',
      text: 'Водитель АБАКАН-АСКИЗ-ст.АСКИЗ (можно Новостройка) С МЕСТА ДО МЕСТА выезд 10.30 -/+ 30мин звоните [phone] есть 2 места',
      signal: 'review-only:transport-door-to-door-operator',
    },
    {
      hash: 'e6af1bd57f46',
      text: 'Нужны пассажиры из Кызыла в Абакан [phone] выезд 12-13ч на комфортном авто!',
      signal: 'review-only:transport-promotional-vehicle-wording',
    },
    {
      hash: 'fa230e22e8c3',
      text: 'Сегодня 22.07.26г еду УФа -ЖД-Бакалы в 23.45 - 00.30ч есть места,, округ Галле [phone] Аэропорт',
      signal: 'review-only:transport-airport-station-waypoint',
    },
    {
      hash: 'fce73355fc4c',
      text: 'ВОДИТЕЛЬ бл время НОВОСТРОЙКА АСКИЗ АБАКАН ЧЕРНОГОРСК [phone] ДО МЕСТА',
      signal: 'review-only:transport-door-to-door-operator',
    },
  ])('routes manually adjudicated ambiguous transport $hash to review-only', ({ text, signal }) => {
    const result = detect(text, {
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 45,
        commercialAdsDeleteThreshold: 65,
      },
    });

    expect(result?.matchedSignals).toEqual([signal]);
    expect(result?.confidenceScore).toBe(0);
    expect(result?.actionScore).toBe(0);
    expect(result?.actionBand).toBe('REVIEW_ONLY');
    expect(result?.actionable).toBe(false);
    expect(result?.recordable).toBe(false);
    expect(result?.suppressionReasons).toContain('ambiguous-transport-review-only');
  });

  it.each([
    [
      'door-to-door operator',
      'Водитель АБАКАН-АСКИЗ-ст.АСКИЗ (можно Новостройка) С МЕСТА ДО МЕСТА выезд 10.30 -/+ 30мин звоните +7 900 000-12-34 есть 2 места',
      'review-only:transport-door-to-door-operator',
    ],
    [
      'airport and station waypoint',
      'Сегодня 22.07.26г еду УФа -ЖД-Бакалы в 23.45 - 00.30ч есть места, округ Галле 8 (900) 000-12-35 Аэропорт',
      'review-only:transport-airport-station-waypoint',
    ],
    [
      'promotional vehicle wording',
      'Нужны пассажиры из Кызыла в Абакан +7 (900) 000-12-36 выезд 12-13ч на комфортном авто!',
      'review-only:transport-promotional-vehicle-wording',
    ],
  ])('routes runtime raw-phone ambiguous transport to review-only: %s', (_label, text, signal) => {
    const result = detect(text, {
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 45,
        commercialAdsDeleteThreshold: 65,
      },
    });

    expect(result?.matchedSignals).toEqual([signal]);
    expect(result?.actionBand).toBe('REVIEW_ONLY');
    expect(result?.actionable).toBe(false);
    expect(result?.recordable).toBe(false);
  });

  it.each([
    [
      'Telegram group rules with ordinary stickers and forbidden links',
      'Группа для общения. Правила: разрешены музыка, видео и стикеры. Запрещены любые ссылки, спам и реклама. За нарушение правил удаляем. Переходите по ссылке [url].',
    ],
    [
      'official warning about illegal fuel resale',
      'Администрация города предупредила о недопустимости запасов бензина. Некоторые массово скупают топливо, хранят его на складах и перепродают с рук. За незаконную перепродажу без лицензии предусмотрен штраф по КоАП. Если знаете о таких фактах, сообщите по телефону [phone]. Подробнее [url].',
    ],
    [
      'private apartment sale with ordinary specifications',
      'Срочная продажа квартиры! Две комнаты, площадь 67 кв.м. Частично остается мебель. Цена 4 400 000. Телефон [phone].',
    ],
    [
      'owner explicitly declining realtor services',
      'Продам отличную квартиру, цена 8 700 000, собственник (с риэлторами не сотрудничаю). Тел. [phone].',
    ],
  ])('allows a confirmed 48-hour audit false positive: %s', (_label, text) => {
    expect(detect(text)).toBeNull();
  });

  it('does not hide a direct fuel offer behind a generic fine disclaimer', () => {
    const result = detect(
      'АЗС Энергия: АИ-95 в наличии. Цена 70 руб/литр, заказ топлива и доставка [phone]. Администрация предупреждает о штрафах за незаконную перепродажу.',
    );

    expect(result).not.toBeNull();
    expect(result?.safeContextBucket).toBe('none');
    expect(result?.actionBand).not.toBe('REVIEW_ONLY');
  });

  it.each([
    [
      'door-to-door one-off without an ambiguity qualifier',
      'Водитель аскиз-абакан-черногорск 7.20+- [phone] С места до места',
      'review-only:transport-door-to-door-operator',
    ],
    [
      'one-way station rideshare',
      '23.07 Суходол-Самара в 05:45 до ЦАВ есть места 600р. тел. [phone]',
      'review-only:transport-single-date-schedule',
    ],
    [
      'airport-origin private rideshare',
      'Сейчас с аэропорта 4 пассажира попутно уедут с Красноярска до Кызыла тел [phone]',
      'review-only:transport-airport-station-waypoint',
    ],
    [
      'passenger request without promotional vehicle wording',
      'Сегодня 13-14ч нужны пассажиры из Кызыла в Абакан [phone]',
      'review-only:transport-promotional-vehicle-wording',
    ],
    [
      'driver recollection',
      'Водитель рассказал, как вчера ехал Абакан-Аскиз с места до места. Телефон редакции [phone].',
      'review-only:transport-door-to-door-operator',
    ],
    [
      'passengers for a film scene',
      'Нужны пассажиры для учебной съёмки: актёр довезёт их до аэропорта на комфортном авто. Телефон студии [phone].',
      'review-only:transport-promotional-vehicle-wording',
    ],
  ])('keeps a neighboring ambiguous-transport negative allowed: %s', (_label, text, signal) => {
    const result = detect(text);

    expect(result?.matchedSignals ?? []).not.toContain(signal);
    expect(result?.actionBand ?? 'ALLOW').toBe('ALLOW');
  });

  it('does not assemble a professional transfer from an unrelated film narrative', () => {
    const result = detect(
      'Нужны пассажиры для учебной съёмки: актёр довезёт их до аэропорта. В другом эпизоде герой передаст посылку. Реквизит включает билет. Телефон студии [phone].',
    );

    expect(result?.matchedSignals ?? []).not.toContain(
      'service-specialty:professional-passenger-parcel-transfer',
    );
    expect(['ALLOW', 'REVIEW_ONLY']).toContain(result?.actionBand ?? 'ALLOW');
  });

  it.each([
    [
      'one-off route to a station with a fare',
      'Сегодня 23.07 в 17:30-18:00 еду из Серноводска через Суходол в Самару до автовокзала есть места 700₽ [phone] ЗВОНИТЕ, смс не читаю',
    ],
    [
      'dated parcel ride without a return leg',
      '27.07 еду ЗЕЯ-БЛАГОВЕЩЕНСК возьму попутчиков и посылки [phone]',
    ],
    [
      'round trip without parcel or door-to-door service anchors',
      '23.07 Еду Аромашево Тюмень в 15.30 и обратно Тюмень Аромашево в 19.00 тел [phone]',
    ],
    [
      'door-to-door ride without a return leg',
      'Водитель Абакан Аскиз Новостройка В ближайшее время С места до места [phone]',
    ],
    [
      'two-stop round trip remains a private rideshare',
      'Водитель 29.05.26 ст. АСКИЗ-АБАКАН и обратно, с места до места, выезд со станции 8.30 + 30 мин. Звоните +7 900 000 00 29, есть 1 место.',
    ],
    [
      'airport and station waypoints without a transfer offer',
      'Сегодня 22.07.26г еду УФа -ЖД-Бакалы в 23.45 - 00.30ч есть места, округ Галле [phone] Аэропорт',
    ],
    [
      'food preorder and airport document pickup in separate clauses',
      'На встрече обсудили предварительный заказ еды. Потом заберу документы из аэропорта. Телефон справочной [phone].',
    ],
    [
      'survey passengers and station parcel pickup in separate clauses',
      'Нужны пассажиры для опроса. Посылку заберу на вокзале. На билете есть QR-код. Телефон организатора [phone].',
    ],
    [
      'parcel handoff and meeting times without route geometry',
      'Пассажиры передадут посылки обратно. Встречи назначены на 10:00 и 12:00. Телефон организатора [phone].',
    ],
    [
      'phone groups are not scheduled route times',
      'Беру пассажиров и посылки, обратно. Телефон +7 900 000 00 00',
    ],
    [
      'a route date is not a departure time',
      'Водитель 29.05.26 Аскиз-Аскиз-АБАКАН и обратно. С места до места. Телефон +7 900 000 00 00',
    ],
  ])('keeps the transport boundary non-actionable: %s', (_label, text) => {
    const result = detect(text, {
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 45,
        commercialAdsDeleteThreshold: 65,
      },
    });
    const targetedSignals = new Set([
      'service-specialty:advance-airport-station-transfer',
      'service-specialty:professional-passenger-parcel-transfer',
      'service-specialty:scheduled-round-trip-door-to-door',
      'service-specialty:scheduled-round-trip-parcel-route',
      'service-specialty:taxiing-contact-self-offer',
    ]);

    expect(result?.matchedSignals.some((signal) => targetedSignals.has(signal)) ?? false).toBe(
      false,
    );
    expect(['ALLOW', 'REVIEW_ONLY']).toContain(result?.actionBand ?? 'ALLOW');
  });

  it.each([
    [
      'event bus hire',
      'ЗАКАЗ АВТОБУСА СИТРОЕН С КОНДИЦИОНЕРОМ, СВАДЬБА ЮБИЛЕЙ И ДР [phone].',
      'service-specialty:event-bus-hire',
      'WARN',
      45,
      65,
    ],
    [
      'explicit taxi self-offer',
      'Работаю как таксист по городу и межгороду, готов отвезти пассажиров.',
      'service-specialty:taxi-driver-self-offer',
      'WARN',
      45,
      65,
    ],
    [
      'scheduled passenger and parcel route',
      'Есть свободные места Благовещенск-Зея 23 июля 13:00, 17:00, 24 июля 9:00, 13:00. Зея-Благовещенск 23 июля 9:00, 24 июля 13:00, 17:00. Доставка посылок.',
      'service-specialty:scheduled-passenger-parcel-route',
      'WARN',
      50,
      70,
    ],
    [
      'multi-route fare table',
      'ДОВЕЗЕМ ДО МОРЯ. АНАПА, ГЕЛЕНДЖИК - 7000 ₽ в две стороны, каждый день. СОЧИ, АДЛЕР - 9000 ₽ в 2 стороны, каждый день. Телефон: [phone].',
      'service-specialty:multi-route-transport-table',
      'DELETE',
      45,
      65,
    ],
  ])(
    'detects a commercial structured transport offer: %s',
    (_label, text, signal, action, warnThreshold, deleteThreshold) => {
      const result = detect(text, {
        settings: {
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: warnThreshold,
          commercialAdsDeleteThreshold: deleteThreshold,
        },
      });

      expect(result?.primarySubtype).toBe('SERVICES');
      expect(result?.matchedSignals).toContain(signal);
      expect(result?.actionBand).toBe(action);
    },
  );

  it('does not treat a hyphenated equipment-driver vacancy as a route fare table', () => {
    const result = detect(
      'В строительную компанию требуется водитель экскаватора-погрузчика. Управление экскаватором-погрузчиком. Оплата 470 руб/час, доход 70000 руб. График каждый день с 08:00. Телефон [phone].',
    );

    expect(result?.primarySubtype).toBe('RECRUITMENT');
    expect(result?.matchedSignals).not.toContain('service-specialty:multi-route-transport-table');
  });

  it('restores the explicit risk for driver licenses sold without exams', () => {
    const result = detect(
      'Оформление водительских прав без экзаменов и автошколы. Документы вносятся в официальную базу. Заказать: https://example.com/docs.',
    );

    expect(result?.matchedSignals).toContain('risk:document-service');
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it('rejects an oversized scheduled-route near miss before bounded signal scans', () => {
    const n = 100_000;
    const nearMiss = `есть свободные места доставка посылок Москва-Тула ${'а'.repeat(n - 100)} 10:00 11:00 12:00 13:00`;
    const startedAt = performance.now();

    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect(ADS_SCHEDULED_PASSENGER_PARCEL_ROUTE_PATTERN.test(nearMiss)).toBe(false);
    }

    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  it('rejects oversized structured transport near misses before bounded signal scans', () => {
    const oversized = `${'а'.repeat(100_000)} таксую предварительный заказ встреча с аэропорта пассажиры посылки обратно с места до места [phone]`;
    const patterns = [
      ADS_TAXIING_CONTACT_SELF_OFFER_PATTERN,
      ADS_ADVANCE_AIRPORT_STATION_TRANSFER_PATTERN,
      ADS_PROFESSIONAL_PASSENGER_PARCEL_TRANSFER_PATTERN,
      ADS_SCHEDULED_ROUND_TRIP_PARCEL_ROUTE_PATTERN,
      ADS_SCHEDULED_ROUND_TRIP_DOOR_TO_DOOR_PATTERN,
    ];
    const startedAt = performance.now();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      for (const pattern of patterns) {
        expect(pattern.test(oversized)).toBe(false);
      }
    }

    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  it.each([
    'В МФЦ можно заказать дубликат аттестата государственного образца. Телефон [phone].',
    'В городском архиве можно заказать архивный дубликат диплома государственного образца. Телефон [phone].',
  ])('does not escalate an official credential duplicate request', (text) => {
    const result = detect(text);

    expect(result?.matchedSignals ?? []).not.toContain('risk:document-service');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    'Мастер Иван сделал нам ремонт. Ремонт квартир под ключ от 5000 руб, выезд и замер бесплатно. Телефон +7 900 000 60 01.',
    'Мастер Иван сделал нам ремонт. Берётся за ремонт квартир, цена от 5000 руб. Телефон +7 900 000 60 02.',
    'Мастер Иван сделал нам ремонт. Оказывает ремонтные услуги, цена от 5000 руб. Телефон +7 900 000 60 03.',
  ])('keeps a current priced service offer after a completed-work recommendation', (text) => {
    const result = detect(text);

    expect(result?.primarySubtype).toBe('SERVICES');
    expect(['WARN', 'DELETE']).toContain(result?.actionBand);
  });

  it('does not link a separate paid master class to free raffle mechanics', () => {
    const result = detect(
      'Разыграем приз среди подписчиков. Мастер-класс: участие 500 рублей. Запись по телефону +7 900 000 60 04.',
    );

    expect(result?.matchedSignals ?? []).not.toContain('risk:paid-raffle');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it('recognizes an editorial debunking of a pseudomedical claim', () => {
    const result = detect(
      'В статье опровергают заявления: биорезонанс заменяет анализы, МРТ и УЗИ. Доказательств нет. Телефон редакции +7 900 000 60 05.',
    );

    expect(result?.matchedSignals ?? []).not.toContain('risk:pseudomedical-diagnostics');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    'Биорезонанс заменяет анализы, МРТ и УЗИ. При этом он не заменяет консультацию врача. Запись [phone].',
    'Биорезонанс выявляет причины аллергии и бесплодия. Терапевт не выявляет скрытые причины. Запись [phone].',
  ])('does not let an unrelated negation hide a pseudomedical claim', (text) => {
    const result = detect(text);

    expect(result?.matchedSignals).toContain('risk:pseudomedical-diagnostics');
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    'МБОУ школа объявляет запись в 1 класс. Телефон [phone].',
    'Предварительная запись на приём депутата по телефону [phone].',
    'Городская поликлиника открыла запись на приём врача. Телефон [phone].',
    'Администрация приглашает на бесплатную экскурсию. Запись [phone], подробности [url].',
  ])('does not enforce an official or free public appointment', (text) => {
    expect(detect(text)?.actionBand ?? 'ALLOW').toBe('ALLOW');
  });

  it.each(['участку', 'двору', 'саду'])(
    'does not turn mowing ones own %s into a local service offer',
    (place) => {
      const result = detect(`Завтра скашу траву триммером по ${place}.`);

      expect(result?.matchedSignals ?? []).not.toContain(
        'service-specialty:local-mowing-self-offer',
      );
      expect(result?.actionBand ?? 'ALLOW').toBe('ALLOW');
    },
  );

  it('does not treat reported competition results as a promotional giveaway', () => {
    const result = detect(
      'Победитель турнира получил приз 100000 рублей. Канал Спорт сообщил итоги: [url].',
    );

    expect(result?.actionBand ?? 'ALLOW').toBe('ALLOW');
  });

  it('keeps a sanitized third-party contractor reference out of enforcement', () => {
    const result = detect(
      'Ремонт обсуждали на собрании, телефон подрядчика [phone] указан в акте.',
    );

    expect(result?.actionBand ?? 'ALLOW').toBe('ALLOW');
  });

  it('uses a local paid-entry signal to enforce a campaign-distributed raffle', () => {
    const result = detect(
      'Денежная группа!!! Лоты от 135 и выше!!! Собираем бонус и возвращаем деньги на баланс!!! Заходи, испытай удачу [url].',
      { commercialCampaignContext: REPEATED_PRIVATE_RESALE_CONTEXT },
    );

    expect(result?.matchedSignals).toContain('risk:paid-raffle');
    expect(result?.matchedSignals).toContain('transaction:paid-raffle-entry');
    expect(result?.suppressionReasons).not.toContain('campaign-only');
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it('recognizes the audited rare-script paid gambling group locally', () => {
    const result = detect(
      '[url] Э ᴛ ᥲ ᴦ ρ у ᥰ ᥰ ᥲ. Л ᧐ ᴛ ы. 5 0 ᥙ ᴦ ρ ᥲ ᥔ, д ᥱ н ь ᴦ ᥙ. З ᥲ х ᧐ д ᥙ.',
    );

    expect(result?.matchedSignals).toContain('risk:paid-gambling-group');
    expect(result?.matchedSignals).toContain('transaction:paid-gambling-entry');
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    'Бесплатный розыгрыш магазина: номер выдаём за покупку, доплачивать не нужно. [url]',
    'Вход на фестиваль 500 рублей. Отдельно проведём бесплатный розыгрыш среди гостей. [url]',
    'Конкурс рисунков, организационный взнос 500 рублей. Победителя определяет жюри. [phone]',
    'Аукционный лот выставлен повторно, оплата победившей ставки переводом на карту [phone].',
    'Э ᴛ ᥲ ᴦ ρ у ᥰ ᥰ ᥲ - ᥰ ρ ᧐ ᥴ ᴛ ᧐ κ ᧘ ᥲ ᥴ ᥴ. Новости клуба [url].',
  ])('does not turn a non-chance context into paid gambling: %s', (text) => {
    const result = detect(text);

    expect(result?.matchedSignals ?? []).not.toContain('risk:paid-gambling-group');
    expect(result?.matchedSignals ?? []).not.toContain('transaction:paid-raffle-entry');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    [
      'trade credential solicitation',
      'Можно сделать корочки маляра? Напишите в личку.',
      'transaction:illicit-document-deal',
    ],
    [
      'migration registration sale',
      'Регистрация куямиз. Прямой хозяин, гарантия. [phone]',
      'transaction:illicit-registration-deal',
    ],
    [
      'formal document catalog',
      'ИНН оригинал, СНИЛС оригинал, медкнижка, диплом, права и патент. Гарантия. WhatsApp [phone].',
      'transaction:illicit-document-deal',
    ],
  ])('escalates the narrow illicit document case: %s', (_label, text, transactionSignal) => {
    const result = detect(text);

    expect(result?.matchedSignals).toContain(transactionSignal);
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    'Здравствуйте, нужны корочки изолировщика.',
    'Восстановлю повреждённую обложку удостоверения, без изменения документа. [phone]',
    'Учебный центр: обучение, экзамен и выдача удостоверения. Лицензия на сайте [url].',
    'Работодатель бесплатно оформляет регистрацию кандидатов и трудовой договор. [phone]',
    'Хозяйка зарегистрирует гостей при заселении по договору аренды. [phone]',
    'Официальный запрос на регистрацию подайте через МФЦ. Телефон справочной [phone].',
    'Помощь в прохождении санминимума с обучением и экзаменом. Запись [phone].',
  ])('keeps the legal credential or registration context out of illicit risk: %s', (text) => {
    const result = detect(text);

    expect(result?.matchedSignals ?? []).not.toContain('risk:migration-registration-service');
    expect(result?.matchedSignals ?? []).not.toContain('transaction:illicit-document-deal');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    'Оформление водительских прав без экзаменов и очередей. Все категории: A, B, C, D. Без походов в ГИБДД и автошколу. Документы вносятся в официальную базу, готовность 14 дней. Пишите прямо сейчас: https://max.ru/u/example-driver-docs',
    'Права без экзамена не выдаются, но диплом без обучения сделаем и внесем в реестр, пишите [phone].',
  ])('keeps a later illicit credential offer after local context: %s', (text) => {
    const result = detect(text);

    expect(result?.matchedSignals).toContain('risk:document-service');
    expect(result?.matchedSignals).toContain('transaction:illicit-document-deal');
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it('escalates paid reviews with bare compensation and a response link', () => {
    const result = detect('Платим на отзывы на продукцию, 2-3 отзыва 1500. Пишите + [url]');

    expect(result?.matchedSignals).toContain('risk:paid-review-task');
    expect(result?.matchedSignals).toContain('transaction:paid-review-compensation');
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it('escalates a paid-review task when guaranteed payment follows the review request', () => {
    const result = detect(
      'Не спам! Ищу 15 человек, написать пару постов и отзывов. Гарантированная оплата 3000₽, за срочность доплата 500₽. За подробностями пиши ВК [url]',
    );

    expect(result?.matchedSignals).toContain('risk:paid-review-task');
    expect(result?.matchedSignals).toContain('transaction:paid-review-compensation');
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    'Оставьте честный отзыв о покупке, оплаты за отзыв нет. [url]',
    'Вакансия менеджера по работе с отзывами: отвечать клиентам, оклад 50000 руб. [phone]',
    'Оплата труда 50000 руб. Работа с отзывами клиентов, отвечать на комментарии. Для отклика пишите [url].',
    'Осторожно: мошенники платят за отзывы и присылают ссылки. Не переходите по ним.',
  ])('does not create paid-review risk without payment, task and response intent: %s', (text) => {
    const result = detect(text);

    expect(result?.matchedSignals ?? []).not.toContain('risk:paid-review-task');
    expect(result?.matchedSignals ?? []).not.toContain('transaction:paid-review-compensation');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it('escalates mixed-script bot-income recruitment', () => {
    const result = detect(
      'Hужнa paботa? Зaпyсkaй Бoтa! Живыe дeньги. Зaпyсkaй бoтa нa кaнaлe [url]',
    );

    expect(result?.primarySubtype).toBe('RECRUITMENT');
    expect(result?.matchedSignals).toContain('risk:bot-income-scam');
    expect(result?.matchedSignals).toContain('recruitment:bot-income-work');
    expect(result?.matchedSignals).toContain('transaction:bot-income-leadgen');
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    'Перед сменой запусти служебного бота и отметь начало работы.',
    'Запусти бота для оплаты коммунальных услуг, квитанция появится в личном кабинете.',
    'Для проверки системы запусти бота. Доход бюджета вырос после обновления. Новости проекта опубликованы на канале [url].',
    'Осторожно, мошенники пишут: «Запускай бота, получай живые деньги». Не переходите по ссылке [url].',
  ])('keeps operational or warning bot text out of income-scam risk: %s', (text) => {
    const result = detect(text);

    expect(result?.matchedSignals ?? []).not.toContain('risk:bot-income-scam');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    [
      'casino offer',
      'Казино: бонус 100% ... https://bad.example',
      'Осторожно, мошенники копируют нас. Казино: бонус 100% ... https://bad.example',
      'risk:betting-gambling',
    ],
    [
      'paid review offer',
      'Платим 3500₽ за отзыв на Wildberries. Свободный график, ежедневные задания, без опыта и вложений. Выдаем аванс и товар в подарок. Чтобы начать, пишите плюс в чат: https://example.com/wb-review',
      'Осторожно, мошенники копируют наши объявления. Платим 3500₽ за отзыв на Wildberries. Свободный график, ежедневные задания, без опыта и вложений. Выдаем аванс и товар в подарок. Чтобы начать, пишите плюс в чат: https://example.com/wb-review',
      'risk:paid-review-task',
    ],
    [
      'bot income offer',
      'Hужнa paботa? Зaпyсkaй Бoтa! Живыe дeньги. Зaпyсkaй бoтa нa кaнaлe [url]',
      'Осторожно, мошенники копируют наш канал. Hужнa paботa? Зaпyсkaй Бoтa! Живыe дeньги. Зaпyсkaй бoтa нa кaнaлe [url]',
      'risk:bot-income-scam',
    ],
    [
      'pseudomedical offer',
      'Акция: биорезонансное обследование организма заменяет биохимию крови, МРТ, КТ и УЗИ, выявляет причины аллергии и бесплодия. Предварительная запись [phone].',
      'В статье писали, что это якобы не доказано. Акция: биорезонансное обследование организма заменяет биохимию крови, МРТ, КТ и УЗИ, выявляет причины аллергии и бесплодия. Предварительная запись [phone].',
      'risk:pseudomedical-diagnostics',
    ],
  ])(
    'does not let an unrelated warning hide an independent %s',
    (_label, baselineText, prefixedText, riskSignal) => {
      const baseline = detect(baselineText);
      const prefixed = detect(prefixedText);

      expect(baseline?.matchedSignals).toContain(riskSignal);
      expect(prefixed?.matchedSignals).toContain(riskSignal);
      expect(baseline?.actionBand).toBe('DELETE_AND_ESCALATE');
      expect(prefixed?.actionBand).toBe('DELETE_AND_ESCALATE');
      expect(prefixed?.safeContextBucket).toBe('none');
    },
  );

  it.each([
    [
      'animal-derived medicinal catalog',
      'Продам бобровую струю, пантогематоген, пантокрин и сухие панты в капсулах. Отправка почтой, заказы [phone].',
      'risk:unregulated-medicinal-goods',
    ],
    [
      'structured plant tincture',
      'Продам настойку листьев лопуха, 70%, 0,33 л, 300 руб. Телефон [phone].',
      'risk:unregulated-medicinal-goods',
    ],
    [
      'natural bear hide',
      'Продам натуральную настоящую шкуру медведя, качественная выделка. Звонить [phone].',
      'risk:wildlife-product-sale',
    ],
  ])('escalates the regulated goods offer: %s', (_label, text, riskSignal) => {
    const result = detect(text);

    expect(result?.matchedSignals).toContain(riskSignal);
    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    'Рецепт настойки лопуха: листья залить водой, цена не указана, продажи нет.',
    'В аптеке продаётся зарегистрированный препарат пантокрин по назначению врача. [phone]',
    'Косметическое пихтовое масло без лечебных заявлений. Цена 300 руб, заказ [phone].',
    'В музее открылась экспозиция: старинная шкура медведя как исторический экспонат. [phone]',
    'Продам искусственную эко-шкуру, имитация медведя. Доставка, [phone].',
    'В новостях сообщили о конфискации шкуры медведя у браконьеров.',
  ])('keeps the safe medicinal or wildlife context out of escalation: %s', (text) => {
    const result = detect(text);

    expect(result?.matchedSignals ?? []).not.toContain('risk:unregulated-medicinal-goods');
    expect(result?.matchedSignals ?? []).not.toContain('risk:wildlife-product-sale');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    [
      'medicinal article',
      'Продам кухонный шкаф, цена 5000 руб. В статье рассказываем о бобровой струе, пантогематогене и пантокрине. Читать [url].',
    ],
    [
      'wildlife article',
      'Продам кухонный шкаф, цена 5000 руб. В статье опубликована фотография шкуры медведя из музейной коллекции. Смотреть [url].',
    ],
  ])('does not join a cabinet sale to an unrelated %s', (_label, text) => {
    const result = detect(text);

    expect(result?.matchedSignals ?? []).not.toContain('risk:unregulated-medicinal-goods');
    expect(result?.matchedSignals ?? []).not.toContain('risk:wildlife-product-sale');
    expect(result?.matchedSignals ?? []).not.toContain(
      'transaction:unregulated-medicinal-goods-deal',
    );
    expect(result?.matchedSignals ?? []).not.toContain('transaction:wildlife-product-deal');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    'Проведём бесплатный розыгрыш среди пассажиров. Билет на автобус стоит 500 рублей, отправление в 18:00. [url]',
    'Проведём бесплатный розыгрыш среди гостей. Билет на концерт стоит 500 рублей. [url]',
  ])('does not attach a transport or event ticket to a free raffle: %s', (text) => {
    const result = detect(text);

    expect(result?.matchedSignals ?? []).not.toContain('risk:paid-raffle');
    expect(result?.matchedSignals ?? []).not.toContain('transaction:paid-raffle-entry');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it('does not turn an archived, explicitly denied credential into an illicit offer', () => {
    const result = detect(
      'В архиве хранятся дипломы выпускников. Водительские права без экзамена не выдаются. Телефон справочной [phone].',
    );

    expect(result?.matchedSignals ?? []).not.toContain('risk:document-service');
    expect(result?.matchedSignals ?? []).not.toContain('transaction:illicit-document-deal');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it('does not create transaction evidence from a warning that only mentions paid reviews', () => {
    const result = detect(
      'Осторожно: мошенники обещают оплату за отзывы и присылают ссылки. Не отвечайте и сообщите администратору [url].',
    );

    expect(result?.matchedSignals ?? []).not.toContain('risk:paid-review-task');
    expect(result?.matchedSignals ?? []).not.toContain('transaction:paid-review-compensation');
    expect(result?.matchedSignals ?? []).not.toContain('transaction:high-risk-offer');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it('caps an organized wellness trip at WARN without pseudomedical escalation', () => {
    const result = detect(
      'Собираем группу для оздоровления на термально-грязевых источниках. Встречаем, размещаем и сопровождаем. Проживание от 1000 руб, проезд 14000р. Места ограничены, запись [phone].',
    );

    expect(result?.primarySubtype).toBe('SERVICES');
    expect(result?.matchedSignals).toContain('service-specialty:organized-wellness-trip');
    expect(result?.matchedSignals).not.toContain('risk:pseudomedical-diagnostics');
    expect(result?.actionBand).toBe('WARN');
  });

  it.each([
    [
      'divination expert identity',
      '🔮 ЭКСПЕРТ ТАР0 • 25 ЛЕТ 🔮 💯 100% гарантия 📲 [phone] 👉 Max • Telegram • WhatsApp',
      'service-specialty:divination-self-offer',
    ],
    [
      'hereditary fortune teller',
      '🔮✨ Анна — потомственная гадалка, ✨🔮 💫🔮💫 🙏 Двери открыты для всех — рада помочь! 📱 [phone] WhatsApp • Max',
      'service-specialty:divination-self-offer',
    ],
    [
      'first person divination',
      '⚡️ Любовь Григорьевна ⚡️ 👑 Гадаю 🤍 Индивидуально, с душой, конфиденциально 📲 [phone]',
      'service-specialty:divination-self-offer',
    ],
    [
      'photo divination',
      '🧿 ГАДАЮ🧿 🃏 По фото: ПРОШЛОЕ • БУДУЩЕЕ • НАСТОЯЩЕЕ 📲 [phone] Max • WhatsApp • Telegram',
      'service-specialty:divination-self-offer',
    ],
    [
      'room capacity and nightly price',
      '(4х местный номер) в Сочи цена в сутки за номер 2700р',
      'service-specialty:seasonal-lodging-offer',
    ],
    [
      'dated family lodging package',
      '25 июля по 30 июля - 5 ночей за 12т.р. для Вашей семьи (4х местный номер) в Сочи',
      'service-specialty:seasonal-lodging-offer',
    ],
    [
      'explicit seasonal room rental',
      'Сдаю комнаты в частном доме в Сочи, п. Лазаревское. Посуточно 500 р. с человека в сутки. Для связи [phone].',
      'service-specialty:seasonal-lodging-offer',
    ],
  ])('recalls the audited conservative %s offer at WARN', (_label, text, signal) => {
    const result = detect(text, {
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 45,
        commercialAdsDeleteThreshold: 65,
      },
    });

    expect(result?.primarySubtype).toBe('SERVICES');
    expect(result?.matchedSignals).toContain(signal);
    expect(result?.actionBand).toBe('WARN');
    expect(result?.suppressionReasons).toContain('conservative-recall-warn-cap');
  });

  it.each([
    'Ищу гадалку. Номер [phone] оказался неверным, поделитесь проверенным контактом.',
    'На лекции разбираем Таро. Запись участников по телефону [phone].',
    'Ищу 4-местный номер в Сочи на 5 ночей, бюджет 12 т.р.',
    'Мы жили в Сочи 5 ночей, номер стоил 2700 р. в сутки, делюсь отзывом.',
  ])('keeps a divination or lodging near-miss out of conservative recall: %s', (text) => {
    const result = detect(text);

    expect(result?.matchedSignals ?? []).not.toContain('service-specialty:divination-self-offer');
    expect(result?.matchedSignals ?? []).not.toContain('service-specialty:seasonal-lodging-offer');
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    'Гадаю индивидуально. Цена 5000 руб, запись [phone], подробности [url].',
    '(4х местный номер) в Сочи, цена за сутки 2700 руб. Бронирование [phone], [url].',
  ])('keeps conservative recall at WARN with price and link: %s', (text) => {
    const result = detect(text, {
      commercialCampaignContext: REPEATED_PRIVATE_RESALE_CONTEXT,
    });

    expect(result?.actionBand).toBe('WARN');
    expect(result?.suppressionReasons).toContain('conservative-recall-warn-cap');
  });

  it('does not let conservative recall weaken independent property or escalation evidence', () => {
    const propertyOffer =
      'Агентство недвижимости: ЖК Флора, студия 24 м2 за 3.450.000 руб, квартира 32 м2 за 4.250.000 руб. Звоните [phone].';
    const propertyOnly = detect(propertyOffer);
    const combined = detect(`Гадаю индивидуально, запись [phone]. ${propertyOffer}`);
    const escalated = detect(
      'Гадаю индивидуально, запись [phone]. Деньги до зарплаты онлайн, одобрим без отказа, hxxp://credit dot ru',
    );

    expect(propertyOnly?.actionBand).toBe('DELETE');
    expect(combined?.actionBand).toBe('DELETE');
    expect(combined?.suppressionReasons).not.toContain('conservative-recall-warn-cap');
    expect(escalated?.actionBand).toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    [
      'agent object id',
      'Дом - аренда. Общая площадь 41.2 м², участок 8 соток. Стоимость 10000. id объекта: 139084214. Ваш агент по недвижимости Вероника. Номер для связи [phone].',
      'property-agent:agent-object-id-contact',
      'PROPERTY_AGENT',
    ],
    [
      'commission rental',
      'Помяловского 1Б Цена:20000 Без залога Комиссия:50% Тел [phone] #снять #аренда #квартира',
      'property-agent:commission-rental-contact',
      'PROPERTY_AGENT',
    ],
    [
      'professional specifications',
      'Мкр Любимово, большая трешка. Этаж 10, отделка предчистовая, без обременений, без долей. 11.500.000 [phone] Илона',
      'property-agent:professional-property-spec-listing',
      'PROPERTY_AGENT',
    ],
    [
      'multi property directory',
      'Продается участок 15 соток, ул. Ореховая 50. Продается комната в общежитии 18 м², Молодежная 5. Все вопросы по тел. [phone].',
      'property-agent:multi-property-directory-contact',
      'PROPERTY_AGENT',
    ],
    [
      'welder vacancy',
      'Сварщик на завод. 5-дневная рабочая неделя. Обеды за счет компании, оклад от 85 тыс. Офиц. труд-во. [phone].',
      'recruitment:role-first-vacancy',
      'RECRUITMENT',
    ],
    [
      'cleaner vacancy',
      'Уборщица на август! Офис, строго с 8.00 до 17.00, зп 53000 руб, график 5/2. По всем вопросам звонить тел [phone].',
      'recruitment:role-first-vacancy',
      'RECRUITMENT',
    ],
  ])(
    'recalls audited property or role-first offer at WARN: %s',
    (_label, text, signal, subtype) => {
      const result = detect(text, {
        settings: {
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 45,
          commercialAdsDeleteThreshold: 65,
        },
      });

      expect(result?.primarySubtype).toBe(subtype);
      expect(result?.matchedSignals).toContain(signal);
      expect(result?.actionBand).toBe('WARN');
      expect(result?.suppressionReasons).toContain('conservative-recall-warn-cap');
    },
  );

  it.each([
    'ЖК Архитектор. Тип квартиры: Евро 3к. Площадь 65 м². Отделка: ремонт, мебель, техника. Квартира на ключах. Показ 24/7. Комиссия: ваша комиссия сверху. Цена 13 500 000 ₽. Звоните прямо сейчас: +7 900 000 00 06.',
    '💎 ЖК Самолет 2💎 🏢 Тип квартиры: Евро 2к 📐 Площадь: 37 м² 🎨 Отделка: Ремонт Мебель Тех 🔑 Квартира на ключах ⏰ Показ: 24/7 — в любое удобное время 💼 Комиссия: ваша комиссия сверху 💸 Цена: 6.500.000 ₽ 💸 📞 Звоните прямо сейчас: +7 900 000 00 19',
  ])('keeps every audited broker anchor visible: %s', (text) => {
    const result = detect(text);

    expect(result?.matchedSignals).toEqual(
      expect.arrayContaining([
        'property-agent:комиссия-сверху',
        'property-agent:на-ключах',
        'property-agent:показ-247',
      ]),
    );
    expect(result?.actionBand).toBe('DELETE');
  });

  it.each([
    'Собственник, продаю свою квартиру в мкр Любимово: этаж 10, отделка предчистовая, без обременений, цена 11.500.000, телефон [phone].',
    'Без посредников продаю свои участок и комнату. Все вопросы по телефону [phone].',
    'Я уборщица, ищу работу в офисе, желателен график 5/2, телефон [phone].',
    'Сварщик рассказал, как раньше работал на заводе. График был 5/2, зарплата 85000. Телефон редакции [phone].',
  ])(
    'does not create conservative property or vacancy evidence from a private/narrative case: %s',
    (text) => {
      const result = detect(text);

      expect(result?.matchedSignals ?? []).not.toContain('recruitment:role-first-vacancy');
      expect(result?.matchedSignals ?? []).not.toContain(
        'property-agent:professional-property-spec-listing',
      );
      expect(result?.matchedSignals ?? []).not.toContain(
        'property-agent:multi-property-directory-contact',
      );
      expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
    },
  );

  it('treats a role-first HR contact question as job seeking, not a vacancy', () => {
    const result = detect(
      'Сварщик. График 5/2, зарплата 80 тыс. Подскажите телефон отдела кадров [phone].',
    );

    expect(result?.matchedSignals ?? []).not.toContain('recruitment:role-first-vacancy');
    expect(result?.actionBand ?? 'ALLOW').toBe('ALLOW');
  });

  it('does not cap an independently deletable property offer after wellness wording', () => {
    const propertyOffer =
      'Агентство недвижимости сдаёт апартаменты посуточно. Цена 6000 руб за сутки, свободные даты и бронирование по ссылке [url], телефон [phone].';
    const propertyOnly = detect(propertyOffer);
    const combined = detect(
      `Собираем группу для оздоровления на термальных источниках. Встречаем, размещаем и сопровождаем. Проживание от 1000 руб, проезд 14000р. Места ограничены, запись [phone]. ${propertyOffer}`,
    );

    expect(propertyOnly?.actionBand).toBe('DELETE');
    expect(combined?.actionBand).toBe('DELETE');
    expect(combined?.reviewReasons).not.toContain('organized-wellness-trip');
  });

  it.each([
    [
      'banquet hall capacity without whitespace',
      'Банкетный зал принимает заказы. Вместимость от 100-300чᴇᴧ, заранее бронируйте даты по телефону [phone].',
      'service-specialty:banquet-hall-catalog',
      'SERVICES',
    ],
    [
      'well drilling self-offer',
      'Бурим абиссинские скважины на воду под ключ. Для расчета глубины звоните [phone].',
      'service-specialty:well-drilling-self-offer',
      'SERVICES',
    ],
    [
      'cosmetic procedure catalog',
      'Нужны модели на увеличение губ и ботокс, коррекция подбородка и мезотерапия. Запись [url].',
      'service-specialty:cosmetic-procedure-catalog',
      'SERVICES',
    ],
    [
      'construction service catalog',
      'Строительная бригада выполняет наружные и внутренние работы, принимаем заявки по телефону [phone].',
      'service-specialty:construction-service-catalog',
      'SERVICES',
    ],
    [
      'named store stock promotion',
      'В магазине «Семейный» в продажу поступили свежие курочки гриль. Ждем за покупками!',
      'goods-retail:named-store-stock-promotion',
      'GOODS_RETAIL',
    ],
  ])('recalls the audited catalog or store offer at WARN: %s', (_label, text, signal, subtype) => {
    const result = detect(text, {
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 45,
        commercialAdsDeleteThreshold: 65,
      },
    });

    expect(result?.primarySubtype).toBe(subtype);
    expect(result?.matchedSignals).toContain(signal);
    expect(result?.actionBand).toBe('WARN');
    expect(result?.suppressionReasons).toContain('conservative-recall-warn-cap');
  });

  it.each([
    [
      'В магазине «Хлеб» сегодня не было курочек гриль, продавец обещал уточнить поставку.',
      'goods-retail:named-store-stock-promotion',
    ],
    [
      'Кто бурил скважину на воду, сколько метров получилось?',
      'service-specialty:well-drilling-self-offer',
    ],
    [
      'Ищу банкетный зал на 100-300 чел, поделитесь отзывами и проверенным телефоном.',
      'service-specialty:banquet-hall-catalog',
    ],
    [
      'На лекции обсуждали увеличение губ, ботокс, коррекцию подбородка и мезотерапию.',
      'service-specialty:cosmetic-procedure-catalog',
    ],
    [
      'Кто делал наружные и внутренние строительные работы, какую бригаду посоветуете?',
      'service-specialty:construction-service-catalog',
    ],
    [
      'В прошлом году наша строительная бригада закончила наружные и внутренние работы.',
      'service-specialty:construction-service-catalog',
    ],
  ])('keeps a catalog or store near-miss out of conservative recall: %s', (text, signal) => {
    const result = detect(text);

    expect(result?.matchedSignals ?? []).not.toContain(signal);
    expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
  });

  it.each([
    {
      line: 3840,
      signal: 'goods-retail:named-manufacturer-price-catalog',
      text: 'Если давно присматриваете новую кровать, возможно, эта информация будет полезна 😊 В «Фабрике кроватей 38» изготавливают современные кровати с мягким изголовьем, которые легко впишутся практически в любой интерьер. ✔️ Ортопедическое основание уже входит в стоимость. Размеры и цены: • 80×200 — 16 900 ₽ • 90×200 — 17 900 ₽ • 120×200 — 18 900 ₽ • 140×200 — 19 900 ₽ • 160×200 — 21 900 ₽ • 180×200 — 23 900 ₽ Дополнительно можно заказать: • подъемный механизм — +3 500 ₽; • ящики для белья — +2 500 ₽. Матрас приобретается отдельно. Есть в наличие разные модели, подберем матрас именно под вас🤝 Все кровати производятся в Иркутске. Можно приехать, посмотреть образцы и выбрать ткань в выставочном зале по адресу: ул. Партизанская, 73. Если планируете обновить спальню или ищете качественную кровать по разумной цене — загляните, возможно, найдете именно свой вариант. 😊',
    },
    {
      line: 25064,
      signal: 'goods-retail:inventory',
      text: 'Цемент привезли, кто заказывал ожидаем. В наличии, цена 865р Тел [phone], [phone] Действует доставка',
    },
    {
      line: 42857,
      signal: 'goods-retail:passive-multi-sku-order-catalog',
      text: 'Добрый день дорогие садоводы.💗 Сейчас принимаются заказы,повторные в этом году. ✅Гортензии метельчатые 3 х летки-1500₽ ✅Гортензия первая в мире-Махровая карлик Мечта Лескова 1 год-1500₽ ✅Сирень карликовая Мейера -900₽ (цветет 2раза за сезон) ✅Ель голубая: Супер Блю Сидлинг-2500₽ ✅Ель голубаяМажестик Блю-2500₽ ✅Сосна горная Мугус-2500₽ ✅Ель карлик Нидиформис-2500₽ ✅Калина Бульдонеж 2л-950₽ ✅Ирга -2л-850₽ ✅Лиана Лимонник китайский -570₽ ✅Дерен-800₽ ✅Спирея-800₽ ✅Калина-850₽ ✅Черноплодка-700₽ ✅Ель сизая Глаука 950₽ ✅Хвойные:Туи, можжевельники 1200₽ ✅Хоста редкие 1200₽ Присоединяйтесь👍 Самовывоз: ✅п. Крупской ул. Кузнецкая 6 ✅Верх-Тула ул. Солнечная 5, парковка ✅Г. Новосибирск ул. Толмачёвское шоссе 2Б [phone] Алина 🌷Саженцы ✅Отправку саженцев можно: ✅Яндекс доставкой ✅Такси Спасибо за доверие🩷 и красоту на ваших участках🥰 Ссылку на группу скину в личку⏫🍓🍏🍊🍋🌷',
    },
    {
      line: 57844,
      signal: 'group-promo:owned-classifieds-network',
      text: 'Добро пожаловать в сообщество!💥Чита и Забайкальский край!💥Здесь вы можете разместить свое объявление!Взаимный обмен ссылками только телеграм MAX! Приглашайте друзей и знакомых! Наши группы MAX: Смоленка-Благодатный [url] Куплю продам Чита [url] Благодатный [url]',
    },
    {
      line: 89600,
      signal: 'goods-retail:furniture-stock-installment',
      text: 'Очень много мебели есть в наличии , пишите что вас интересует 😍 Можно приобрести мебель в рассрочку на 6 месяцев ✅✅✅✅✅ В наличии есть 👇 Шкафы Комоды Кровати Диваны ТВ тумбы Гостинки Столы Стулья Обувницы Прихожки Кухонные гарнитуры И ещё много мебели ‼️ Наш Макс 👇 [url]',
    },
    {
      line: 101039,
      signal: 'goods-retail:first-person-custom-manufacturing',
      text: 'Украсьте свой дом и сад изысканными кашпо!🔥 Изготавливаю на заказ кашпо из искусственного ротанга разного объема, цвета и формы.🪴 Подписывайтесь на каналы за интересными идеями Макс: [url] Вк: [url]',
    },
    {
      line: 117459,
      signal: 'group-promo:multi-chat-directory',
      text: 'Чаты Макс 1. Биржа Рекламы 2. Пиар Чат 3. Группа по России 4. Взаимные Ссылки Рассылка по Чатам МАКС Татьяна Взаимная подписка | ПИАР •Вкусные рецепты •Стикеры Макс •Маникюр дизайн •Игры, Поделки, Рисунки •Лайфхаки •Вб Скидки ✨✨✨✨✨✨✨✨✨✨ Каталог Каналов и Групп [url] [url] [url] [url] [url] [url] [url] [url] [url] [url] [url]',
    },
  ])('keeps the audited 24-hour commercial offer on line $line actionable', ({ text, signal }) => {
    const result = detect(text, {
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 45,
        commercialAdsDeleteThreshold: 65,
      },
    });

    expect(result?.matchedSignals).toContain(signal);
    expect(result?.actionBand).toBe('WARN');
    expect(result?.actionable).toBe(true);
  });

  it.each([
    [
      'manufacturer report',
      'Соседка рассказывала: фабрика кроватей «Сон» изготавливает кровати. Цены, по её словам, 16000 ₽, 17000 ₽ и 18000 ₽; можно приехать в выставочный зал. Контактов продавца у меня нет.',
    ],
    [
      'quoted nursery catalog',
      'Цитирую пример рекламы, а не предложение: «Принимаются заказы. Гортензия 1500₽, сирень 900₽, ель 2500₽, туя 1200₽. Самовывоз или доставка, телефон [phone]».',
    ],
    [
      'third-party nursery catalog',
      'Соседка сказала, что в питомнике принимаются заказы: гортензия 1500₽, сирень 900₽, ель 2500₽, туя 1200₽. Самовывоз или доставка, телефон продавца [phone]. Я ничего не продаю.',
    ],
    [
      'furniture buyer request',
      'Подскажите, где много мебели в наличии? Пишите предложения мне. Нужна рассрочка: шкафы, комоды, кровати, диваны, столы и стулья.',
    ],
    [
      'editorial furniture catalog',
      'В статье приведен пример рекламы: «Много мебели в наличии, пишите что вас интересует. Есть рассрочка: шкафы, комоды, кровати, диваны, столы и стулья». Это цитата, не предложение.',
    ],
    [
      'third-party furniture recommendation',
      'Соседка рекомендует магазин: там много мебели в наличии, пишите ей. Есть рассрочка: шкафы, комоды, кровати, диваны, столы и стулья.',
    ],
    [
      'custom planter buyer question',
      'Подскажите, это объявление актуально: «Изготавливаю на заказ кашпо разного объема, цвета и формы. MAX [url], VK [url]»?',
    ],
    [
      'quoted custom planter catalog',
      'Цитирую пример рекламы, а не предложение: «Изготавливаю на заказ кашпо разного объема, цвета и формы. MAX [url], VK [url]».',
    ],
    [
      'third-party custom planter catalog',
      'Мастер Анна пишет в своем объявлении: «Изготавливаю на заказ кашпо разного объема, цвета и формы. MAX [url], VK [url]». Это чужое объявление.',
    ],
    [
      'cement buyer request',
      'Ищу цемент в наличии, цена 865 руб. меня устроит. Для связи мои два телефона [phone] [phone], нужна доставка.',
    ],
    [
      'editorial cement report',
      'По данным обзора, цемент в наличии, цена 865 руб., телефоны поставщика [phone] [phone], действует доставка. Редакция ничего не продает.',
    ],
    [
      'third-party cement report',
      'Сосед сообщил: цемент в наличии, цена 865 руб., телефоны продавца [phone] [phone], есть доставка. Я не продавец.',
    ],
    [
      'editorial ecommerce report',
      'В обзоре редакция упоминает: Юра мебельный — интернет-магазин. У него каталог более 100 моделей, доставка и оплата при получении; ссылка [url]. Это не реклама.',
    ],
    [
      'third-party ecommerce recommendation',
      'Соседка советует: Юра мебельный — интернет-магазин, каталог более 100 моделей, доставка и оплата при получении. Пишите ей [phone].',
    ],
    [
      'service buyer with attributed response',
      'Кто оказывает услуги клининга? Компания «Чисто» предоставляет клининг от 5000 руб.? Если знаете, звоните мне [phone].',
    ],
    [
      'editorial service quote',
      'Кто оказывает услуги клининга, обсуждали в обзоре. Компания «Чисто» предоставляет клининг от 5000 руб. Звоните [phone] — так дословно цитирует реклама, это не предложение.',
    ],
  ])('keeps an attributed 24-hour commercial near-miss non-actionable: %s', (_label, text) => {
    const result = detect(text);

    expect(['ALLOW', 'REVIEW_ONLY']).toContain(result?.actionBand ?? 'ALLOW');
    expect(result?.actionable ?? false).toBe(false);
  });

  it.each([
    'Цитирую пример рекламы, а не предложение: «Чужой магазин продает мебель». Отдельно продаем цемент: в наличии, цена 865 руб., доставка, звоните [phone].',
    'Соседка советует магазин мебели, пишите ей [phone]. Но наша компания предоставляет клининг от 5000 руб. Звоните [phone].',
    'По данным обзора редакция ничего не продает. А мы изготавливаем кашпо на заказ, цена от 3000 руб., пишите [phone].',
  ])('does not let an attributed report hide an independent source-side offer: %s', (text) => {
    const result = detect(text);

    expect(['WARN', 'DELETE', 'DELETE_AND_ESCALATE']).toContain(result?.actionBand);
    expect(result?.actionable).toBe(true);
    expect(result?.safeContextBucket).toBe('none');
    expect(result?.matchedSignals).toContain('locality:independent-commercial-offer');
  });

  it.each([
    'Подскажите, кто размещает рекламу в каналах. Цена до 5000 руб, мой телефон [phone].',
    'Ищу подрядчика на ремонт квартиры. Бюджет 300000 руб, звоните [phone].',
    'Ищу поставщика мебели в наш магазин. Бюджет 50000 руб., мой телефон [phone].',
    'Ищу поставщика мебели для нашего магазина, бюджет до 50000 руб. Свои предложения пишите мне [phone].',
    'Кто поставляет мебель в магазины? Нужен прайс до 50000 руб., мой телефон [phone].',
    'Нужна реклама нашего магазина в районных каналах. Бюджет до 5000 руб., предложения мне [phone].',
    'Нужна доставка товара в наш магазин. Цена до 5000 руб., мой телефон [phone].',
    'Подскажите ассортимент мебели для нашего магазина. Бюджет 50000 руб., мой телефон [phone].',
  ])('keeps a buyer-owned commercial request non-actionable: %s', (text) => {
    const result = detect(text);

    expect(['ALLOW', 'REVIEW_ONLY']).toContain(result?.actionBand ?? 'ALLOW');
    expect(result?.actionable ?? false).toBe(false);
  });

  it.each([
    'Я ищу, кто убирает офисы. Бюджет до 10000 руб., мой телефон [phone].',
    'Как мы убираем офис после ремонта?',
    'Мы убираем помещение сами, подрядчик не нужен.',
  ])('does not turn a first-person cleaning discussion into an offer: %s', (text) => {
    expect(detect(text)).toBeNull();
  });

  it.each([
    'Наш магазин предлагает поставки мебели. Прайс от 50000 руб., пишите нам [phone].',
    'Размещаем рекламу в районных каналах, цена от 5000 руб., пишите нам [phone].',
  ])('does not apply buyer ownership to an explicit seller-side offer: %s', (text) => {
    const result = detect(text);

    expect(['WARN', 'DELETE', 'DELETE_AND_ESCALATE']).toContain(result?.actionBand);
    expect(result?.actionable).toBe(true);
  });

  it.each([
    'Компания Чистый Город предоставляет уборку от 5000 руб., звоните [phone].',
    'Кто оказывает услуги клининга? Нужна команда, бюджет до 10000 руб. Компания Чистый Город предоставляет уборку от 5000 руб., звоните [phone].',
    'Кто оказывает услуги клининга? Нужна команда, бюджет до 10000 руб. Я убираю офисы, цена от 5000 руб., звоните [phone].',
    'Кто оказывает услуги клининга? Нужна команда, бюджет до 10000 руб. Мы убираем офисы, цена от 5000 руб., пишите нам [phone].',
    'Кто оказывает услуги клининга? Нужна команда, бюджет до 10000 руб. Компания Чисто оказывает клининг от 5000 руб., звоните нам [phone]. Перед началом сделаем обзор объекта.',
    'Кто оказывает услуги клининга? Нужна команда, бюджет до 10000 руб. Компания Чисто оказывает клининг от 5000 руб., обращайтесь к нам [phone]. В стоимость входит редакция договора.',
    'Кто оказывает услуги клининга? Нужна команда, бюджет до 10000 руб. Компания Чисто оказывает клининг от 5000 руб., пишите [phone]. Цитируем отзывы клиентов в портфолио.',
  ])('keeps a named company service offer actionable: %s', (text) => {
    const result = detect(text);

    expect(['WARN', 'DELETE', 'DELETE_AND_ESCALATE']).toContain(result?.actionBand);
    expect(result?.actionable).toBe(true);
  });

  it.each([
    'Для обучения модераторов приводим пример рекламного сообщения: «Подписывайтесь на наш канал скидок https://max.ru/shop». Это нарушение, его надо удалить.',
    'В инструкции разбираем пример рекламы: «Подписывайтесь на наш канал скидок https://max.ru/shop». Это не предложение.',
    'Модератор цитирует нарушение: «Подписывайтесь на наш канал скидок https://max.ru/shop». Это не предложение.',
    'В обзоре цитируем продавца: «Продаем диваны от 20000 руб. Доставка. Звоните [phone]». Это цитата, не предложение.',
    'Редакция цитирует поставщика: «Продаем дизельное топливо оптом. Цена 65 руб. за литр. Звоните [phone]». Это не предложение.',
    'Журналист цитирует компанию: «Продаем диваны от 20000 руб. Доставка. Звоните [phone]». Это цитата, не предложение.',
    'В обзоре приводим слова продавца: «Продаем диваны от 20000 руб. Доставка. Звоните [phone]». Это цитата, не предложение.',
    'Пример запрещенной рекламы: «Подписывайтесь на наш канал скидок https://max.ru/shop». Это нарушение, удалите сообщение.',
  ])('keeps an explicit moderation example non-actionable: %s', (text) => {
    const result = detect(text);

    expect(['ALLOW', 'REVIEW_ONLY']).toContain(result?.actionBand ?? 'ALLOW');
    expect(result?.actionable ?? false).toBe(false);
  });

  it.each([
    {
      label: 'straight quotes in strict mode',
      openingQuote: '"',
      closingQuote: '"',
      settings: {},
    },
    {
      label: 'straight quotes in balanced mode',
      openingQuote: '"',
      closingQuote: '"',
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 57,
        commercialAdsDeleteThreshold: 77,
      },
    },
    {
      label: 'curly quotes in strict mode',
      openingQuote: '“',
      closingQuote: '”',
      settings: {},
    },
    {
      label: 'curly quotes in balanced mode',
      openingQuote: '“',
      closingQuote: '”',
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 57,
        commercialAdsDeleteThreshold: 77,
      },
    },
    {
      label: 'Russian secondary quotes in strict mode',
      openingQuote: '„',
      closingQuote: '“',
      settings: {},
    },
    {
      label: 'Russian secondary quotes in balanced mode',
      openingQuote: '„',
      closingQuote: '“',
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 57,
        commercialAdsDeleteThreshold: 77,
      },
    },
  ] as const)(
    'keeps a multi-sentence editorial quote non-actionable with $label',
    ({ openingQuote, closingQuote, settings }) => {
      const result = detect(
        `Редакция цитирует продавца: ${openingQuote}Продаем цемент. Мы предлагаем ремонт квартир, цена 5000 ₽, пишите [phone]${closingQuote}. Это цитата, не предложение.`,
        { settings },
      );

      expect(['ALLOW', 'REVIEW_ONLY']).toContain(result?.actionBand ?? 'ALLOW');
      expect(result?.actionable ?? false).toBe(false);
    },
  );

  it('does not let a moderation example hide a later owned promotion', () => {
    const result = detect(
      'Для обучения модераторов приводим пример рекламы: «Подписывайтесь на канал скидок [url]». Это нарушение. Но наш магазин продает мебель, заказывайте [url].',
    );

    expect(['WARN', 'DELETE', 'DELETE_AND_ESCALATE']).toContain(result?.actionBand);
    expect(result?.actionable).toBe(true);
  });

  it('does not let a qualified editorial quote hide a later owned promotion', () => {
    const result = detect(
      'В обзоре цитируем продавца: «Продаем диваны от 20000 руб. Звоните [phone]». Это цитата, не предложение. Отдельно продаем цемент: цена 865 руб., доставка, звоните [phone].',
    );

    expect(['WARN', 'DELETE', 'DELETE_AND_ESCALATE']).toContain(result?.actionBand);
    expect(result?.actionable).toBe(true);
    expect(result?.safeContextBucket).toBe('none');
  });

  it('does not let Russian secondary quotes hide a later owned promotion', () => {
    const result = detect(
      'В обзоре цитируем продавца: „Продаем диваны от 20000 руб. Звоните [phone]“. Это цитата, не предложение. Отдельно продаем цемент: цена 865 руб., доставка, звоните [phone].',
    );

    expect(['WARN', 'DELETE', 'DELETE_AND_ESCALATE']).toContain(result?.actionBand);
    expect(result?.actionable).toBe(true);
    expect(result?.safeContextBucket).toBe('none');
  });

  it('keeps a high-risk buyer request non-actionable', () => {
    const result = detect(
      'Подскажите, кто оказывает помощь с займом без отказа? Нужен вариант, бюджет до 50000 руб., предложения пишите мне [phone].',
    );

    expect(result).toBeNull();
  });

  it('does not let a high-risk buyer request hide a separate loan offer', () => {
    const result = detect(
      'Подскажите, кто оказывает помощь с займом без отказа? Нужен вариант, бюджет до 50000 руб., предложения пишите мне [phone]. Отдельно: оформим займ без отказа за 15 минут, оставьте заявку [url].',
    );

    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
    expect(result?.actionable).toBe(true);
    expect(result?.analysisText).toContain('оформим займ без отказа');
  });

  it('does not let a qualified quote hide a separate loan offer', () => {
    const result = detect(
      'В обзоре цитируем продавца: «Кредит онлайн без отказа, оставьте заявку [url]». Это цитата, не предложение. Отдельно: оформим займ без отказа за 15 минут, оставьте заявку [url].',
    );

    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
    expect(result?.actionable).toBe(true);
    expect(result?.analysisText).toContain('оформим займ без отказа');
  });

  it('does not extract a topic-change marker from inside a qualified quote', () => {
    const result = detect(
      'Редакция цитирует пример рекламы: «Новости магазина. Отдельно: кредит онлайн без отказа, оставьте заявку [url]». Это цитата, не предложение.',
    );

    expect(['ALLOW', 'REVIEW_ONLY']).toContain(result?.actionBand ?? 'ALLOW');
    expect(result?.actionable ?? false).toBe(false);
  });

  it.each([
    'Кто выдает займы без отказа? Пишите предложения мне [phone].',
    'Кто оформляет займы без отказа? Бюджет до 50000 руб., мой телефон [phone].',
    'Новости района. По другой теме: ищу займ без отказа, пишите предложения мне [phone].',
  ])('keeps a high-risk buyer-side request non-actionable: %s', (text) => {
    expect(detect(text)).toBeNull();
  });

  it('does not let a local-news footer hide a separate casino offer', () => {
    const result = detect(
      'Новости района: открыли парк. Подписывайтесь на канал района [url]. Отдельно: онлайн-казино с бонусом, играйте https://win4land.com.',
    );

    expect(result?.actionBand).toBe('DELETE_AND_ESCALATE');
    expect(result?.actionable).toBe(true);
    expect(result?.analysisText).toContain('онлайн-казино');
  });

  it.each([
    [
      'lead-generation training recap',
      'На семинаре обсуждали поиск клиентов для мастеров красоты, материалы по ссылке [url]. Отдельно: оформим займ без отказа, оставьте заявку [url].',
      'DELETE_AND_ESCALATE',
    ],
    [
      'channel metrics report',
      'Отчет по каналу: ER24 12%, рекламный пост стоил 500р у конкурента, размещение не продаём. Отдельно: оформим займ без отказа, оставьте заявку [url].',
      'DELETE_AND_ESCALATE',
    ],
    [
      'currency-rate news',
      'Курс доллара сегодня вырос, новости валютного рынка. Отдельно: обменник валют: доллар покупка 79, продажа 81. Работаем ежедневно, телефон [phone].',
      'WARN',
    ],
    [
      'giveaway results report',
      'Победитель турнира получил приз, организаторы подвели итоги и опубликовали результаты. Отдельно: оформим займ без отказа, оставьте заявку [url].',
      'DELETE_AND_ESCALATE',
    ],
  ] as const)(
    'does not let a protected %s hide a separate commercial offer',
    (_label, text, expectedAction) => {
      const result = detect(text);

      expect(result?.actionBand).toBe(expectedAction);
      expect(result?.actionable).toBe(true);
      expect(result?.analysisText).toBeDefined();
    },
  );

  it('keeps third-person fuel price analytics non-actionable', () => {
    expect(
      detect(
        'По данным мониторинга, АЗС продают АИ-95 в среднем по 60 руб. за литр, цена выросла за неделю.',
      ),
    ).toBeNull();
  });

  it.each([
    'По данным мониторинга, АЗС продают бензин АИ-95 по 70 руб. Средняя цена выросла. Телефон редакции [phone].',
    'По данным мониторинга, АЗС Энергия продает АИ-95 по 70 руб. Телефон АЗС [phone]. Средняя цена выросла.',
  ])('does not turn a third-party fuel report with a phone into an owned offer: %s', (text) => {
    expect(detect(text)).toBeNull();
  });

  it.each([
    ['STRICT', 38, 55],
    ['BALANCED', 57, 77],
  ] as const)(
    'keeps editorial fuel contacts non-actionable while preserving an explicit station CTA in %s',
    (commercialAdsSensitivity, commercialAdsWarnThreshold, commercialAdsDeleteThreshold) => {
      const settings = {
        commercialAdsSensitivity,
        commercialAdsWarnThreshold,
        commercialAdsDeleteThreshold,
      };
      for (const text of [
        'По данным мониторинга, на АЗС Энергия бензин АИ-95 в наличии по 70 руб/л. По вопросам публикации звоните в редакцию [phone].',
        'Новости района: на АЗС Энергия бензин АИ-95 в наличии по 70 руб/л. Телефон редакции [phone].',
      ]) {
        expect(detect(text, { settings })?.actionable ?? false).toBe(false);
      }

      const stationOffer = detect(
        'По данным мониторинга, на АЗС Энергия бензин АИ-95 в наличии по 70 руб/л. Для заказа топлива звоните на АЗС [phone].',
        { settings },
      );

      expect(stationOffer?.matchedSignals).toContain(
        'recall-source:goods-retail:explicit-fuel-retail',
      );
      expect(stationOffer?.actionable).toBe(true);
    },
  );

  it('keeps a source-owned fuel offer after analytics actionable', () => {
    const result = detect(
      'По данным мониторинга, цена бензина выросла за неделю. Отдельно: на нашей АЗС продаём АИ-95 по 60 руб. за литр, заказывайте [phone].',
    );

    expect(result?.actionBand).toBe('WARN');
    expect(result?.actionable).toBe(true);
  });

  it('keeps discussion prefilters aligned with commercial-normalized text', () => {
    const fuelReport = collectSignals(
      'Б е н з и н теперь закончился, очередь на заправке большая.',
    );
    const localNews = collectSignals(
      'Новости района: магазин Орион объявил скидки на школьные товары. П о д п и ш и т е с ь на канал новостей района https://max.ru/news',
    );

    expect(fuelReport.negativeSignals).toContain('context:fuel-availability-report');
    expect(localNews.negativeSignals).toContain('context:local-news-subscribe');
  });

  it('requires a closing editorial qualifier before protecting a quoted high-risk offer', () => {
    const qualified = detect(
      'Редакция цитирует поставщика: «Кредит онлайн без отказа, оставьте заявку [url]». Это цитата, не предложение.',
    );
    const unqualified = detect(
      'Редакция цитирует поставщика: «Кредит онлайн без отказа, оставьте заявку [url]».',
    );

    expect(['ALLOW', 'REVIEW_ONLY']).toContain(qualified?.actionBand ?? 'ALLOW');
    expect(qualified?.actionable ?? false).toBe(false);
    expect(unqualified?.actionBand).toBe('DELETE_AND_ESCALATE');
    expect(unqualified?.actionable).toBe(true);
  });

  it('evaluates repeated attribution near misses in bounded time', () => {
    const texts = [
      'соседка сказала '.repeat(400).slice(0, 6_000),
      '. соседка сказала '.repeat(400).slice(0, 6_000),
    ];
    const startedAt = Date.now();

    for (const text of texts) {
      for (let iteration = 0; iteration < 2; iteration += 1) {
        expect(detect(text)).toBeNull();
      }
    }
    expect(Date.now() - startedAt).toBeLessThan(350);
  });

  it('distinguishes attributed district news from an owned store-news channel', () => {
    const editorial = detect(
      'Новости района: магазин Орион объявил скидки на школьные товары. Подписывайтесь на канал новостей района https://max.ru/news',
    );
    const normalizedEditorial = detect(
      'Новости района: магазин Орион объявил скидки на школьные товары. П о д п и с ы в а й т е с ь на канал новостей района https://max.ru/news',
    );
    const owned = detect(
      'Новости нашего магазина: новые товары каждый день. Подписывайтесь на наш канал https://max.ru/shop',
    );

    expect(['ALLOW', 'REVIEW_ONLY']).toContain(editorial?.actionBand ?? 'ALLOW');
    expect(editorial?.actionable ?? false).toBe(false);
    expect(['ALLOW', 'REVIEW_ONLY']).toContain(normalizedEditorial?.actionBand ?? 'ALLOW');
    expect(normalizedEditorial?.actionable ?? false).toBe(false);
    expect(['WARN', 'DELETE']).toContain(owned?.actionBand);
    expect(owned?.actionable).toBe(true);
  });

  it.each([
    'После пожара семье нужна помощь. Любая помощь важна. Также наша бригада выполняет ремонт квартир под ключ, цена от 5000 руб., звоните [phone].',
    'Каталог одежды для бойцов и военнослужащих в наличии. Финансовая помощь фронту через покупку. Поддержите наших. Стоимость комплекта 5000 руб. Звоните [phone].',
  ])('does not let a public-help frame hide an independent commercial offer: %s', (text) => {
    const result = detect(text);

    expect(['WARN', 'DELETE']).toContain(result?.actionBand);
    expect(result?.actionable).toBe(true);
  });

  it.each(
    [
      [
        'crypto',
        'Крипто-сигналы: пассивный доход, разбор портфеля и закрытый канал. Пишите https://max.ru/join/crypto',
      ],
      [
        'mixed-script loan',
        'Дeньги дo зapплaты oнлaйн, oдoбpeниe 15 минут, без отказа. Ccылкa в профиле.',
      ],
      [
        'p2p',
        'P2P арбитраж: связки каждый день, депозит от 5000, обучение в закрытом чате, вход по инвайту.',
      ],
      [
        'card drop',
        'Нужны карты для приема переводов, без визита, оплата ежедневно, пишите в тг cashwork77.',
      ],
      [
        'fake documents',
        'Документы об образовании без обучения и экзаменов, с гарантией внесения в реестр. Нужен диплом или аттестат? Оперативное оформление. Пишите в WhatsApp [phone] или Telegram [url].',
      ],
      ['casino', 'Онлайн-казино с быстрыми выплатами. Бонус 5000, играйте https://win4land.com.'],
    ].flatMap(([label, offer]) =>
      [
        'По данным обзора ',
        'Соседка советует ',
        'В статье упоминается ',
        'Редакция сообщает: ',
        'В обзоре разбирали ',
        'В статье рассказали: ',
        'Мне писали: ',
        'Они предлагают: ',
      ].map((prefix) => [`${label}: ${prefix.trim()}`, offer, prefix] as const),
    ),
  )(
    'does not let an unqualified attribution prefix hide high risk: %s',
    (_label, offer, prefix) => {
      const baseline = detect(offer);
      const prefixed = detect(`${prefix}${offer}`);

      expect(baseline?.actionBand).toBe('DELETE_AND_ESCALATE');
      expect(prefixed?.actionBand).toBe(baseline?.actionBand);
      expect(prefixed?.actionable).toBe(true);
    },
  );

  it('protects a delimited high-risk quote only with an explicit editorial qualifier', () => {
    const result = detect(
      'В статье приведен пример рекламы: «Кредит онлайн без отказа, оставьте заявку [url]». Это цитата, не предложение; не переходите по ссылке.',
    );

    expect(['ALLOW', 'REVIEW_ONLY']).toContain(result?.actionBand ?? 'ALLOW');
    expect(result?.actionable ?? false).toBe(false);
  });

  it.each(['. ', '\n', '; ', '… ', '。', '！ ', '.\u00a0— '])(
    'finds a source-side offer after a protected quote with boundary %s',
    (boundary) => {
      const result = detect(
        `Цитирую пример рекламы, а не предложение: «Кредит онлайн без отказа, оставьте заявку [url]»${boundary}А мы продаем цемент: цена 865 руб., доставка, звоните [phone].`,
      );

      expect(['WARN', 'DELETE']).toContain(result?.actionBand);
      expect(result?.actionable).toBe(true);
      expect(result?.actionBand).not.toBe('DELETE_AND_ESCALATE');
    },
  );

  it.each([
    'Соседка сказала, что магазин закрылся. Я не продавец. Продаем диваны и шкафы. Цены от 10000 руб., доставка по России, [phone].',
    'Цитирую рекламный текст, это цитата. Продаем диваны и шкафы. Цены от 10000 руб., доставка по России, [phone].',
  ])('resets attributed context for a standalone source-side catalog: %s', (text) => {
    const result = detect(text);

    expect(['WARN', 'DELETE']).toContain(result?.actionBand);
    expect(result?.actionable).toBe(true);
  });

  it('evaluates long organized-wellness near misses in bounded time', () => {
    const nearMisses = [750, 1_000].map(
      (length) =>
        `Собираем группу ${'для оздоровления на термальных источниках '.repeat(30).slice(0, length)}`,
    );
    const startedAt = Date.now();

    for (const text of nearMisses) {
      const result = detect(text);
      expect(result?.matchedSignals ?? []).not.toContain(
        'service-specialty:organized-wellness-trip',
      );
    }

    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it.each([
    'Едем с друзьями на термальные источники, делим бензин поровну, записи нет.',
    'Администрация организует бесплатную социальную поездку на источники для ветеранов.',
    'В прошлом месяце группа ездила на источники, публикуем отчёт и фотографии.',
  ])('does not create a current organized wellness offer: %s', (text) => {
    const result = detect(text);

    expect(result?.matchedSignals ?? []).not.toContain('service-specialty:organized-wellness-trip');
    expect(result?.actionBand ?? 'ALLOW').toBe('ALLOW');
  });
});
