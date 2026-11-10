import type { CommercialAdCategory } from '@maxim/contracts/settings';
import type { CommercialDetection } from './commercial-ad.detector';
import { inspectUnprotectedCommercialAssertions } from './commercial-local-context';
import {
  ADS_BUYOUT_PATTERNS,
  ADS_CHANNEL_PLACEMENT_PATTERNS,
  ADS_GOODS_RETAIL_PATTERNS,
  ADS_PROPERTY_AGENT_PATTERNS,
  ADS_PROPERTY_COMMERCIAL_PATTERNS,
  ADS_RECRUITMENT_PATTERNS,
  ADS_SERVICE_SPECIALTY_MARKERS,
  ADS_SERVICE_SPECIALTY_PATTERNS,
  type CommercialLabeledPattern,
} from './commercial-patterns';
import { normalizeCommercialText } from './commercial-normalization';

const SALE =
  /(?:^|[^\p{L}])(?:прода(?:ю|[её]м|[её]т|ют|м)|продаж[аи]|в\s+продаже)\s+([^.!?;\n]{2,100})/iu;
const COMMUNITY_INVITE =
  /(?:^|[^\p{L}])(?:вступайте|подпишитесь|подписывайтесь|присоединяйтесь|переходите)(?:[^.!?;\n]{0,60})(?:канал|групп|сообществ|чат)[\p{L}]*/iu;
const COMMERCIAL_CONTENT =
  /(?:каталог|товар|ассортимент|скидк|акци[яию]|продаж|заказ|услуг|прайс)[\p{L}]*/iu;
const ANCILLARY =
  /(?:доставк[аиуойе]+(?:\s+[^,.!;\n]{0,30})?\s+(?:бесплатн[\p{L}]*|включен[\p{L}]*)|бесплатн[\p{L}]*\s+доставк[\p{L}]*|помо(?:жем|гу)\s+(?:подобрать|выбрать)\s+(?:цвет|размер|товар|оттенок)[\p{L}]*|подбор\s+(?:цвета|размера|товара|оттенка))/giu;
const WEAK_RETAIL = new Set([
  'sizes-and-colors',
  'catalog-media',
  'manufacturer',
  'commercial-use',
  'order-flow',
]);
const RETAIL_OFFERS = ADS_GOODS_RETAIL_PATTERNS.filter(({ label }) => !WEAK_RETAIL.has(label));
const STORE =
  /(?:^|[^\p{L}])(?:наш\s+магазин|в\s+нашем\s+магазине|магазин\s+["«])[^.!?;\n]{0,100}/iu;
const SERVICE_ACTION =
  /(?:^|[^\p{L}])(?:(?:оказыва|предлага|предоставля)[\p{L}]*\s+(?:услуг|ремонт|покраск|монтаж|уборк|консультаци)[\p{L}]*|выполня[\p{L}]*\s+(?:покраск|ремонт|монтаж|работ)[\p{L}]*|ремонтиру[\p{L}]*|устанавлива[\p{L}]*|настраива[\p{L}]*|провод[\p{L}]*\s+(?:заняти|урок|консультаци)[\p{L}]*)(?=$|[^\p{L}])/iu;
const SERVICE_HEAD_MARKERS = ADS_SERVICE_SPECIALTY_MARKERS.filter(
  (marker) =>
    ![
      'бетон',
      'торт',
      'выпечк',
      'забор',
      'асфальт',
      'брусчатк',
      'плитк',
      'москит',
      'мастер',
      'бригада',
      'септик',
      'кровл',
    ].includes(marker),
);
function hasServiceHeading(text: string): boolean {
  const heading = normalizeCommercialText(text).replace(/^(?:отдельно|также)\s+/u, '');
  const firstWord = /^[\p{L}-]+/u.exec(heading)?.[0] ?? '';
  if (/(?:ный|ная|ное|ные|ных|ного|ную|ным|ными|ской|ские|ский|ская|ское)$/u.test(firstWord))
    return false;
  return (
    SERVICE_HEAD_MARKERS.some((marker) => heading.startsWith(marker)) ||
    /^(?:покраска|заточка|услуги)(?=$|[^\p{L}])/iu.test(heading)
  );
}
const NON_GOODS_OBJECT =
  /^(?:(?:новый|новые|новое|наш|наши|наше|авторский|авторские|онлайн|свой|свои|собственный|собственные)\s+){0,3}(?:курс|урок|услуг|обучени|вебинар|интенсив|рекламн|размещени)[\p{L}]*(?=$|[^\p{L}])/iu;
const STOCK = /(?:^|[^\p{L}])(?:в\s+наличии|большой\s+ассортимент)(?=$|[^\p{L}])/iu;
const SERVICE_MATERIAL =
  /(?:^|[^\p{L}])для\s+(?:выполнени[яе]\s+)?(?:ремонт[\p{L}]*|перетяжк[\p{L}]*|монтаж[\p{L}]*|установк[\p{L}]*|покраск[\p{L}]*|работ[\p{L}]*)(?=$|[^\p{L}])/iu;
function affirmative(
  pattern: RegExp,
  text: string,
  accept: (match: RegExpMatchArray) => boolean = () => true,
): boolean {
  for (const match of text.matchAll(
    new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g'),
  )) {
    if (
      accept(match) &&
      !/(?:^|[^\p{L}])(?:не|нет)\s*$/iu.test(text.slice(0, (match.index ?? 0) + 1))
    )
      return true;
  }
  return false;
}
function matches(patterns: readonly CommercialLabeledPattern[], text: string): boolean {
  return patterns.some(({ pattern }) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

// FLAG: Ranked subtypes explain the detector score; explicit policy needs the full set of
// actual offers. Protected assertions and incidental fulfillment cannot add a blocked category.
export function deterministicCommercialCategories(
  detection: CommercialDetection,
): CommercialAdCategory[] {
  if (detection.safeContextBucket !== 'none') return [];
  const inspection = inspectUnprotectedCommercialAssertions(detection.rawText);
  if (!inspection.complete) return [];
  const blocks = inspection.blocks.map((block) =>
    block.map((text) =>
      SALE.test(text) || STORE.test(text) || STOCK.test(text)
        ? text.replace(/«[^»]{0,700}»|"[^"]{0,700}"|“[^”]{0,700}”/gu, ' ')
        : text,
    ),
  );
  const assertions = blocks.flat();
  if (!assertions.length) return [];
  const subtypes = [detection.primarySubtype, ...detection.supportingSubtypes];
  const windows = blocks.flatMap((block) =>
    block.map((_, index) =>
      block
        .slice(index, index + 6)
        .join('. ')
        .slice(0, 700),
    ),
  );
  const independentService = assertions.some(
    (text) => affirmative(SERVICE_ACTION, text) || hasServiceHeading(text),
  );
  const business =
    subtypes.some((subtype) =>
      ['GOODS', 'BUYOUT', 'PROPERTY_COMMERCIAL', 'RECRUITMENT'].includes(subtype),
    ) ||
    (subtypes.includes('GOODS_RETAIL') &&
      assertions.some(
        (text) =>
          affirmative(STOCK, text) &&
          !affirmative(SERVICE_ACTION, text) &&
          !hasServiceHeading(text) &&
          (!independentService || (/в\s+наличии/iu.test(text) && !SERVICE_MATERIAL.test(text))),
      )) ||
    windows.some(
      (text) =>
        affirmative(SALE, text, (match) => !NON_GOODS_OBJECT.test(match[1] ?? '')) ||
        affirmative(STORE, text) ||
        matches(RETAIL_OFFERS, text) ||
        matches(ADS_BUYOUT_PATTERNS, text) ||
        matches(ADS_PROPERTY_COMMERCIAL_PATTERNS, text) ||
        matches(ADS_RECRUITMENT_PATTERNS, text),
    );
  const service =
    subtypes.some((subtype) => ['INFO_PRODUCT', 'PROPERTY_AGENT'].includes(subtype)) ||
    assertions.some((text) => {
      const serviceText = business ? text.replace(ANCILLARY, ' ') : text;
      if (
        affirmative(SERVICE_ACTION, serviceText) ||
        matches(ADS_PROPERTY_AGENT_PATTERNS, serviceText)
      )
        return true;
      const normalized = normalizeCommercialText(serviceText);
      const specialty =
        matches(ADS_SERVICE_SPECIALTY_PATTERNS, serviceText) ||
        ADS_SERVICE_SPECIALTY_MARKERS.some((marker) => normalized.includes(marker));
      if (!business) return specialty || subtypes.includes('SERVICES');
      // FLAG: A product's material, brand or intended use is not an independently offered job.
      return (
        specialty &&
        !SALE.test(serviceText) &&
        !STORE.test(serviceText) &&
        !matches(RETAIL_OFFERS, serviceText) &&
        hasServiceHeading(serviceText)
      );
    });
  const community = windows.some(
    (text) =>
      (affirmative(COMMUNITY_INVITE, text) && COMMERCIAL_CONTENT.test(text)) ||
      (/(?:наш|коммерческ[\p{L}]*)\s+(?:канал|чат|групп[\p{L}]*|сообществ[\p{L}]*)/iu.test(text) &&
        COMMERCIAL_CONTENT.test(text) &&
        affirmative(
          /(?:^|[^\p{L}])(?:подписывайтесь|подпишитесь|вступайте)(?=$|[^\p{L}])/iu,
          text,
        )) ||
      matches(ADS_CHANNEL_PLACEMENT_PATTERNS, text),
  );
  return [
    ...(service ? ['SERVICES' as const] : []),
    ...(business ? ['BUSINESS' as const] : []),
    ...(community ? ['COMMUNITIES' as const] : []),
  ];
}
