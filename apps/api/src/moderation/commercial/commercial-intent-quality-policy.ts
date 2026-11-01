import {
  MAX_LOCAL_CONTEXT_LENGTH,
  inspectCommercialAssertions,
  resolveCommercialLocalContext,
} from './commercial-local-context';
import {
  ADS_HIGH_RISK_COMMERCIAL_PATTERNS,
  ADS_HIGH_RISK_RAW_LINK_PATTERNS,
} from './commercial-patterns';
import { hasCommercialPhoneLikeText } from './commercial-phone';
import { resolveCommercialServiceSpeechAct } from './commercial-service-speech-act';

export {
  COMMERCIAL_INTENT_QUALITY_COHORT,
  COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
} from './commercial-policy-cohorts';

const WORD_END = String.raw`(?=$|[^\p{L}\p{N}_-])`;
const PREFIX = String.raw`^[^\p{L}\p{N}_]{0,16}(?:(?:здравствуйте|добрый\s+(?:день|вечер)|соседи|друзья|всем\s+привет)[,!:\s-]{1,8})?(?:(?:отдельно|также|а|но|зато)\s*[:,-]?\s*)?`;
const BUYER = new RegExp(
  String.raw`${PREFIX}(?:(?:я|мы)\s+)?(?:(?:хотел[аи]?|хотим|хочу|хотели|планировал[аи]?|планировали)\s+(?:бы\s+)?(?:заказать|заказывать|купить|воспользоваться)|(?:кому|где|у\s+кого)\s+(?:можно\s+)?(?:заказать|купить))\s+[^.!?;\n]{1,180}`,
  'iu',
);
const PASSIVE_REFUSAL = new RegExp(
  String.raw`${PREFIX}(?:[^.!?;\n]{0,60}\s+)?(?:услуг[а-яё-]*|ремонт[а-яё-]*|заказ[а-яё-]*|доставк[а-яё-]*|изготовлени[а-яё-]*)[^.!?;\n]{0,90}\s+не\s+(?:оказыва(?:ется|ются)|выполня(?:ется|ются)|принима(?:ется|ются)|осуществля(?:ется|ются)|производ(?:ится|ятся))${WORD_END}`,
  'iu',
);
const PRIVATE_ITEM = new RegExp(
  String.raw`${PREFIX}(?:прода(?:ю|м)|прода[её]м)\s+(?:(?:один|одну|свой|свою|сво[её]|наш|нашу|наш[её])\s+|(?:б\s*/\s*у|подержанн[а-яё-]*|стар[а-яё-]*)\s+)(?:[^.!?;\n]{0,45})(?:холодильник[а-яё-]*|диван[а-яё-]*|стол[а-яё-]*|шкаф[а-яё-]*|кресл[а-яё-]*|стиральн[а-яё-]*\s+машин[а-яё-]*|телевизор[а-яё-]*|велосипед[а-яё-]*|телефон[а-яё-]*)${WORD_END}`,
  'iu',
);
const RETAIL_STRUCTURE =
  /(?:^|[^\p{L}\p{N}_-])(?:магазин[а-яё-]*|каталог[а-яё-]*|ассортимент[а-яё-]*|опт(?:ом)?|розниц[а-яё-]*|серийн[а-яё-]*|поставк[а-яё-]*|размер[а-яё-]*\s+и\s+цвет[а-яё-]*|принима(?:ю|ем)\s+заказ[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu;
const INVITATION =
  /(?:^|[^\p{L}\p{N}_-])(?:приглаша(?:ю|ем)|вступайте|присоединяйтесь|подписывайтесь)[^.!?;\n]{0,100}(?:групп[а-яё-]*|чат[а-яё-]*|сообществ[а-яё-]*|канал[а-яё-]*)/iu;
const COMMERCIAL_PURPOSE =
  /(?:^|[^\p{L}\p{N}_-])(?:магазин[а-яё-]*|каталог[а-яё-]*|ассортимент[а-яё-]*|прода(?:ю|ем|[её]т|ют)|(?:при[её]м|принима(?:ю|ем))\s+заказ[а-яё-]*|платн[а-яё-]*\s+(?:размещени[а-яё-]*|услуг[а-яё-]*|обучени[а-яё-]*|курс[а-яё-]*|подписк[а-яё-]*|доступ[а-яё-]*)|(?:цен[аы]|стоимост[а-яё-]*|скидк[а-яё-]*)\s*[:—-]?\s*\d|(?:партн[её]р[а-яё-]*|реферал[а-яё-]*)[^.!?;\n]{0,80}(?:бонус[а-яё-]*|вознаграждени[а-яё-]*|доход[а-яё-]*)|(?:получите|начислим)\s+бонус[а-яё-]*|(?:заработ[а-яё-]*|доход[а-яё-]*)[^.!?;\n]{0,60}\d|(?:заказ[а-яё-]*|реклам[а-яё-]*)[^.!?;\n]{0,40}(?:оплат[а-яё-]*|платн[а-яё-]*))(?=$|[^\p{L}\p{N}_-])/iu;
const NEGATED_COMMERCIAL_PURPOSE =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:без|никаких)\s+(?:реклам[а-яё-]*|продаж[а-яё-]*|оплат[а-яё-]*|платн[а-яё-]*\s+услуг[а-яё-]*)|(?:ничего\s+)?не\s+прода(?:ю|ем|[её]т|ют)|(?:реклам[а-яё-]*|оплат[а-яё-]*|заказ[а-яё-]*)\s+(?:нет|не\s+(?:принима(?:ется|ются)|размеща(?:ется|ются))))(?=$|[^\p{L}\p{N}_-])/giu;
const OWNED_OFFER = new RegExp(
  String.raw`${PREFIX}(?:(?:я|мы|у\s+нас)\s+)?(?:прода(?:ю|ем)|предлага(?:ю|ем)|оказыва(?:ю|ем)|выполня(?:ю|ем)|ремонтиру(?:ю|ем)|изготавлива(?:ю|ем)|дела(?:ю|ем)|шь(?:ю|[её]м)|вяж(?:у|ем)|пек(?:у|[её]м)|доставля(?:ю|ем)|поставля(?:ю|ем)|устанавлива(?:ю|ем)|принима(?:ю|ем)\s+заказ[а-яё-]*)${WORD_END}`,
  'iu',
);
const OWNED_MANUFACTURING = new RegExp(
  String.raw`${PREFIX}(?:(?:я|мы)\s+)?(?:изготавлива(?:ю|ем)|дела(?:ю|ем)|шь(?:ю|[её]м)|вяж(?:у|ем)|пек(?:у|[её]м))[^.!?;\n]{1,180}(?:на\s+заказ|под\s+заказ|по\s+ваш[а-яё-]*\s+(?:дизайн[а-яё-]*|размер[а-яё-]*))${WORD_END}`,
  'iu',
);
const OWNED_ORDER_TAKING = new RegExp(
  String.raw`${PREFIX}(?:(?:я|мы)\s+)?принима(?:ю|ем)\s+заказ[а-яё-]*\s+на\s+[^.!?;\n]{2,180}`,
  'iu',
);
const RHETORICAL_ORDER_INVITATION = new RegExp(
  String.raw`${PREFIX}хотите\s+(?:заказать|приобрести|купить)${WORD_END}`,
  'iu',
);
const OWNED_ORDER_RESPONSE =
  /(?:^|[^\p{L}\p{N}_-])(?:пишите\s+мне|по\s+(?:моему\s+)?номер[у]?\s+телефон[а]?|мне\s+в\s+личн[а-яё-]*\s+сообщени[а-яё-]*)/iu;
const OWNED_ORDER_COMPLETION =
  /(?:^|[^\p{L}\p{N}_-])(?:оформим|оформлю|принимаем|принимаю)\s+заказ[а-яё-]*(?=$|[^\p{L}\p{N}_-])/iu;
const RESPONSE =
  /(?:\[(?:phone|url)\]|https?:\/\/|(?:^|[^\p{L}\p{N}_-])(?:пишите|звоните|обращайтесь|заказывайте|напишите|запись\s+в\s+(?:лс|личк[а-яё-]*))(?=$|[^\p{L}\p{N}_-]))/iu;
const ATTRIBUTED_OR_HISTORICAL =
  /(?:^|[^\p{L}\p{N}_-])(?:раньше|когда-то|в\s+прошлом|больше\s+не|не\s+(?:принима|изготавлива|дела|пеку|шь)|они|мастер|подруг[а-яё-]*|мне\s+(?:сказал[а-яё-]*|предлагал[а-яё-]*)|цитат[а-яё-]*|пример\s+реклам[а-яё-]*|чуж[а-яё-]*\s+объявлени[а-яё-]*)/iu;
const QUOTED_ASSERTION = /^[^\p{L}\p{N}_]{0,16}["«„“]/u;
const CONTRAST_BOUNDARY =
  /,\s*(?=(?:а|но|зато|отдельно|также)\s+(?:(?:я|мы)\s+)?(?:прода(?:ю|ем)|предлага(?:ю|ем)|оказыва(?:ю|ем)|ремонтиру(?:ю|ем)|изготавлива(?:ю|ем)|дела(?:ю|ем)|принима(?:ю|ем)|доставля(?:ю|ем)|поставля(?:ю|ем))(?=$|[^\p{L}\p{N}_-]))/giu;
const SERVICE_CARD_SEED =
  /^(?:только\s+)?(?:ремонт|монтаж|установк[а-яё-]*|услуг[а-яё-]*|сервис)(?=$|[^\p{L}\p{N}_-])/iu;

export type CommercialIntentQualityContext = Readonly<{
  fullyInspected: boolean;
  hasProtectedAssertions: boolean;
  independentOfferTexts: readonly string[];
  ownedOrderOfferTexts: readonly string[];
  protectionReasons: readonly string[];
}>;

// FLAG: Buyer contacts/budgets and a private item's delivery remain owned by that assertion.
// Only an explicit independent author offer resets protection; repetition never creates intent.
export function resolveCommercialIntentQualityContext(
  text: string,
): CommercialIntentQualityContext {
  const inspection = inspectCommercialAssertions(text.replace(CONTRAST_BOUNDARY, '\n'));
  const { assertions } = inspection;
  // FLAG: Quote grouping cannot restore truncated coverage or invalidate a complete 64-item scan.
  const fullyInspected = text.length <= MAX_LOCAL_CONTEXT_LENGTH && inspection.complete;
  const independentOfferTexts: string[] = [];
  const ownedOrderOfferTexts: string[] = [];
  const protectionReasons = new Set<string>();
  let protectedCarry = false;
  for (let index = 0; index < assertions.length; index += 1) {
    const assertion = assertions[index];
    let protection: string | null = null;
    if (BUYER.test(assertion)) protection = 'buyer-request';
    else if (PASSIVE_REFUSAL.test(assertion)) protection = 'passive-refusal';
    else if (PRIVATE_ITEM.test(assertion) && !RETAIL_STRUCTURE.test(assertion))
      protection = 'private-item-delivery';
    else if (INVITATION.test(assertion)) {
      const invitationWindow = boundedWindow(assertions, index);
      if (!hasCommercialPurpose(invitationWindow)) protection = 'noncommercial-invitation';
    }
    if (protection) {
      protectionReasons.add(protection);
      protectedCarry = true;
      continue;
    }
    const speechAct = resolveCommercialServiceSpeechAct(assertion);
    if (speechAct !== 'NONE') {
      protectionReasons.add(`service-${speechAct.toLowerCase()}`);
      protectedCarry = true;
      continue;
    }
    const window = boundedWindow(assertions, index);
    const ownedOrder =
      OWNED_MANUFACTURING.test(assertion) ||
      OWNED_ORDER_TAKING.test(assertion) ||
      (RHETORICAL_ORDER_INVITATION.test(assertion) &&
        OWNED_ORDER_RESPONSE.test(window) &&
        OWNED_ORDER_COMPLETION.test(window));
    const explicitOffer = OWNED_OFFER.test(assertion) || RETAIL_STRUCTURE.test(assertion);
    if (
      (ownedOrder || explicitOffer) &&
      !ATTRIBUTED_OR_HISTORICAL.test(assertion) &&
      !QUOTED_ASSERTION.test(assertion)
    ) {
      independentOfferTexts.push(window);
      if (ownedOrder && (RESPONSE.test(window) || hasCommercialPhoneLikeText(window)))
        ownedOrderOfferTexts.push(window);
      protectedCarry = false;
      continue;
    }
    if (!protectedCarry && INVITATION.test(assertion) && hasCommercialPurpose(assertion))
      independentOfferTexts.push(boundedWindow(assertions, index));
    if (protectedCarry) {
      const riskLabels = [...ADS_HIGH_RISK_COMMERCIAL_PATTERNS, ...ADS_HIGH_RISK_RAW_LINK_PATTERNS]
        .filter(({ pattern }) => pattern.test(assertion))
        .map(({ label }) => label);
      if (!riskLabels.length && !SERVICE_CARD_SEED.test(assertion)) continue;
      const local = resolveCommercialLocalContext({
        rawLoweredText: window,
        escalationRiskLabels: riskLabels,
        includeOrdinaryProtectedContext: true,
        forceInspection: true,
      });
      if (
        local.fullyInspected &&
        local.hasIndependentCommercialOffer &&
        local.independentCommercialOfferText
      ) {
        independentOfferTexts.push(local.independentCommercialOfferText);
        protectedCarry = false;
      }
    }
  }
  return {
    fullyInspected,
    hasProtectedAssertions: protectionReasons.size > 0,
    independentOfferTexts,
    ownedOrderOfferTexts,
    protectionReasons: [...protectionReasons],
  };
}

function hasCommercialPurpose(text: string): boolean {
  return COMMERCIAL_PURPOSE.test(text.replace(NEGATED_COMMERCIAL_PURPOSE, ' '));
}

function boundedWindow(assertions: readonly string[], index: number): string {
  const result = [assertions[index]];
  for (let offset = 1; offset < 6 && index + offset < assertions.length; offset += 1) {
    const next = assertions[index + offset];
    if (
      BUYER.test(next) ||
      PASSIVE_REFUSAL.test(next) ||
      PRIVATE_ITEM.test(next) ||
      resolveCommercialServiceSpeechAct(next) !== 'NONE' ||
      OWNED_OFFER.test(next) ||
      result.join('. ').length + next.length > 700
    )
      break;
    result.push(next);
  }
  return result.join('. ');
}
