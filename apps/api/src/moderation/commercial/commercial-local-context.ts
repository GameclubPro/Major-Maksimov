import { normalizeCommercialText } from './commercial-normalization';
import { hasCommercialPhoneLikeText } from './commercial-phone';
import { hasPaidCommercialPlacementOffer } from './commercial-recall-patterns';
import {
  COMMERCIAL_OWNED_SERVICE_FRAME,
  COMMERCIAL_CANDIDATE_SERVICE_CONTRAST_BOUNDARY,
  COMMERCIAL_SERVICE_CONTRAST_BOUNDARY,
  resolveCommercialServiceSpeechAct,
  type CommercialServiceSpeechAct,
} from './commercial-service-speech-act';
import {
  ADS_ATTRIBUTED_COMMERCIAL_FRAME_PATTERN,
  ADS_BUSINESS_PATTERNS,
  ADS_BUYOUT_PATTERNS,
  ADS_CHANNEL_PLACEMENT_PATTERNS,
  ADS_CONTEXTUAL_PHONE_PLACEHOLDER_PATTERN,
  ADS_EXPLICIT_SOURCE_SIDE_PROMO_FRAME_PATTERN,
  ADS_GOODS_RETAIL_PATTERNS,
  ADS_HANDLE_CONTACT_PATTERN,
  ADS_HIGH_RISK_COMMERCIAL_PATTERNS,
  ADS_HIGH_RISK_RAW_LINK_PATTERNS,
  ADS_LINK_PATTERN,
  ADS_PRICE_PATTERN,
  ADS_PRIVATE_GOODS_PATTERNS,
  ADS_PRIVATE_SINGLE_LISTING_PATTERNS,
  ADS_PROPERTY_AGENT_PATTERNS,
  ADS_PROPERTY_COMMERCIAL_PATTERNS,
  ADS_QUALIFIED_EDITORIAL_QUOTE_PATTERN,
  ADS_RECRUITMENT_PATTERNS,
  ADS_SERVICE_OFFER_PATTERNS,
  ADS_SERVICE_SPECIALTY_MARKERS,
  ADS_SERVICE_SPECIALTY_PATTERNS,
  type CommercialLabeledPattern,
} from './commercial-patterns';

export const MAX_LOCAL_CONTEXT_LENGTH = 8_000;
const MAX_LOCAL_ASSERTIONS = 64;
const MAX_LOCAL_WINDOW_LENGTH = 700;
const MAX_LOCAL_WINDOW_ASSERTIONS = 6;
const MAX_ATTRIBUTED_REPORT_WINDOW_LENGTH = 1_600;
const MAX_STANDALONE_EDITORIAL_INTRO_LENGTH = 240;
const MAX_STANDALONE_EDITORIAL_QUOTE_LENGTH = 1_200;
const TRANSPORT_DEMAND_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:нуж(?:ен|на|но|ны)|ищу|требуется)(?:[^.!?;\n]{0,48})(?:такси|машин[ау]|грузоперевозк[а-яё]*|перевозчик[а-яё]*|\d+\s+мест[ао])(?=$|[^\p{L}\p{N}_-])/iu;

export function hasTransportDemandWithoutOffer(text: string): boolean {
  if (!TRANSPORT_DEMAND_PATTERN.test(text)) return false;
  return !resolveCommercialLocalContext({
    rawLoweredText: text,
    escalationRiskLabels: [],
    includeOrdinaryProtectedContext: true,
  }).hasIndependentCommercialOffer;
}

const CONTRASTIVE_SELF_PROMO_BOUNDARY =
  /,\s*(?=(?:(?:(?:а|но)\s+)?у\s+нас|(?:а|но)\s+мы|зато\s+(?:у\s+нас|мы))(?=$|[^\p{L}\p{N}_-]))/giu;
const WARNING_PREFIX_SELF_PROMO_BOUNDARY =
  /,\s*(?=(?:(?:(?:а|но)\s+)?(?:у\s+нас|мы)|зато\s+(?:у\s+нас|мы)|наш[аи]\s+компани[яи]|я\s+(?:помогу|помогаю|предлагаю|оформлю|выдам)|(?:получите|оставьте\s+заявк[\p{L}\p{N}_-]*|пишите|звоните|заказывайте|оформите|регистрируйтесь|переходите))(?=$|[^\p{L}\p{N}_-]))/giu;
const ASSERTION_BOUNDARY = /(?:[\n!;…。！；]+|\.(?=\s|$))/u;
const QUESTION_ASSERTION_BOUNDARY = /([?？]+)(["'»”’“]?)(?=\s|$|[\p{L}\p{N}])/gu;
const CLOSING_QUOTE_ASSERTION_BOUNDARY = /([.!?…。！？；])(["'»”’“])(?=\s|$|[\p{L}\p{N}])/gu;
const CYRILLIC_CHARACTER_PATTERN = /\p{Script=Cyrillic}/u;
const NO_SPACE_DOT_LEFT_BOUNDARY_PATTERN = /[\p{Script=Cyrillic}\p{N}\]"'»”’“]/u;
const CYRILLIC_DOMAIN_SUFFIXES = new Set(['рф', 'рус', 'москва', 'онлайн', 'сайт']);

const PROHIBITED_ACTION_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:не\s+(?:(?:надо|нужно|стоит)\s+)?(?:звоните?|пишите?|переходите?|открывайте?|регистрируйтесь?|отвечайте?|оставляйте?|отправляйте?|переводите?|платите?|верьте|соглашайтесь|пополняйте?)|не\s+оставляйте?\s+заявк[\p{L}\p{N}_-]*|не\s+сообщайте?\s+(?:код|данн)[\p{L}\p{N}_-]*|заблокируйте|как\s+удалить\s+реклам[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu;
const REPORTING_OR_ATTRIBUTION_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:мне|нам|ему|ей)(?:\s+[\p{L}\p{N}_-]+){0,3}\s+(?:звонил[иа]?|писал[иа]?|предлагал[иа]?|обещал[иа]?|прислал[иа]?)|(?:они|мошенник[\p{L}\p{N}_-]*|спамер[\p{L}\p{N}_-]*)\s+(?:звонят|пишут|предлагают|обещают|рассылают|присылают)|(?:в\s+(?:новост[яьи][\p{L}\p{N}_-]*|стать[еьи]|обзор[еа])|на\s+(?:лекци[иия]|семинар[еа]))\s+(?:разобрал[и]?|разбирал[и]?|обсуждал[и]?|объяснял[и]?|рассказал[и]?|написал[и]?|показал[и]?)|(?:обсуждал[и]?|разбирал[и]?)\s+на\s+(?:встреч[еаи]|совещани[иие]|лекци[иие]|семинар[еаи])|(?:новост[ьи]|стать[яи]|обзор|лекци[яи]|редакци[яи])\s+(?:разбира[а-яё-]*|объясня[а-яё-]*|предупрежда[а-яё-]*|сообща[а-яё-]*))(?=$|[^\p{L}\p{N}_-])/iu;
const QUALIFIED_EDITORIAL_RISK_ASSERTION_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:в\s+новост[а-яё-]*\s+разобрал[а-яё-]*)(?:[^.!?;\n]{0,180})(?:почему|блокир[а-яё-]*|запрещ[а-яё-]*)|(?:кредит[а-яё-]*|займ[а-яё-]*|казино|ставк[а-яё-]*|крипт[а-яё-]*)(?:[^.!?;\n]{0,180})(?:обсуждал[а-яё-]*\s+на\s+(?:встреч[а-яё-]*|лекци[а-яё-]*|семинар[а-яё-]*)|мне\s+только\s+обещал[а-яё-]*))(?=$|[^\p{L}\p{N}_-])/iu;
const EDITORIAL_RISK_INTRO_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:в\s+новост[а-яё-]*\s+разобрал[а-яё-]*|на\s+(?:лекци[а-яё-]*|семинар[а-яё-]*)\s+разбирал[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu;
const EDITORIAL_RISK_FOLLOWUP_PATTERN =
  /^(?:телефон\s+редакци[а-яё-]*|по\s+организационн[а-яё-]*\s+вопрос[а-яё-]*\s+(?:звоните|пишите))(?=$|[^\p{L}\p{N}_-])/iu;
const LOCAL_REPORTING_FRAME_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:мне|нам)\s+отказал[и]?\s+в\s+(?:кредит[еа]?|займ[еа]?|выплат[еа]?|рассрочк[еаи])|(?:в|из)\s+(?:письм[еа]|сообщени[иия]|переписк[еаи])\s+(?:был[аио]?|упоминал[аио]?|написал[аио]?|предлагал[аио]?))(?=$|[^\p{L}\p{N}_-])/iu;
const COMPLAINT_OR_WARNING_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:осторожн[\p{L}\p{N}_-]*|похоже\s+(?:на\s+)?развод|это\s+(?:развод|спам|реклама)|не\s+доверяю|заявк[\p{L}\p{N}_-]*\s+(?:я\s+)?не\s+оставлял[а]?|жалоб[аы]|^отзыв\s*:|сайт\s+опасен|не\s+регистрируйтесь|это\s+реклама\s+или\s+нет|проверял[и]?)(?=$|[^\p{L}\p{N}_-])/iu;
const EDITORIAL_CONTACT_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:телефон|номер|справочн[\p{L}\p{N}_-]*)\s+(?:редакци[иия]|полици[иия]|мошенник[\p{L}\p{N}_-]*|спамер[\p{L}\p{N}_-]*|организатор[а-яё-]*)|их\s+номер|номер\s+(?:из\s+)?сообщени[яи])(?=$|[^\p{L}\p{N}_-])/iu;
const PROTECTED_FRAME_CARRY_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:не\s+(?:звоните?|пишите?|переходите?|открывайте?|регистрируйтесь?))\s+(?:им|ему|ей|по\s+(?:этой\s+)?ссылк[еуы]|на\s+(?:этот\s+)?сайт)|(?:мне|нам)\s+(?:звонил[иа]?|писал[иа]?|предлагал[иа]?|обещал[иа]?)|(?:в\s+(?:новост[яьи][\p{L}\p{N}_-]*|стать[еьи]|обзор[еа])|на\s+(?:лекци[иия]|семинар[еа])))(?=$|[^\p{L}\p{N}_-])/iu;
const SELF_PROMO_RESET_PATTERN =
  /^(?:(?:а|но)\s+)?(?:(?:у\s+нас|мы|наш[аи]\s+компани[яи]|я\s+(?:помогу|помогаю|предлагаю|оформлю|выдам))|(?:отдельно|также|другая\s+тема|по\s+другой\s+теме|ещ[её]\s+одно\s+предложение)\s*[:,-]?\s*(?:прода(?:ю|ем)|предлага(?:ю|ем)|принима(?:ю|ем)\s+заказ[а-яё-]*)|(?:получите|оставьте\s+заявк[\p{L}\p{N}_-]*|пишите|звоните|заказывайте|оформите|регистрируйтесь|переходите))(?=$|[^\p{L}\p{N}_-])/iu;
const PUBLIC_HELP_ASSERTION_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:пожар[а-яё-]*|сгорел[а-яё-]*)(?:[^.!?;\n]{0,180})(?:семь[а-яё-]*|дом[а-яё-]*)(?:[^.!?;\n]{0,180})(?:помощ[а-яё-]*|сбор[а-яё-]*)|семь[а-яё-]*(?:[^.!?;\n]{0,80})нужн[а-яё-]*\s+помощ[а-яё-]*|любая\s+помощь\s+важна)(?=$|[^\p{L}\p{N}_-])/iu;
const AFFIRMATIVE_ACTION_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:пишите?|напишите?|звоните?|обращайтесь|остав(?:ьте|ляйте)\s+заявк[\p{L}\p{N}_-]*|получите|оформите|закаж(?:ите|и|ем|у)|заказывайте|регистрируйтесь|переходите|подписывайтесь|свяжитесь|записывайтесь)(?=$|[^\p{L}\p{N}_-])/giu;
const AFFIRMATIVE_TRANSACTION_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:цен[аы]|стоимость|скидк[а-и]|бонус|депозит|доставка|оплат[аы]|оплатим|платим|вознаграждени[\p{L}\p{N}_-]*|предоплата|бронь|обязательн[\p{L}\p{N}_-]*\s+взнос|участи[ея]\s+платн[\p{L}\p{N}_-]*|в\s+наличии|вход\s+(?:по\s+)?инвайт[\p{L}\p{N}_-]*|ответ[\p{L}\p{N}_-]*\s+в\s+комментар[\p{L}\p{N}_-]*|заявк[\p{L}\p{N}_-]*\s+в\s+профил[еья]|принима(?:ю|ем)\s+заказ[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu;
const AFFIRMATIVE_RESPONSE_CHANNEL_PATTERN =
  /(?:\[(?:phone|url)\]|(?:^|[^\p{L}\p{N}_-])(?:ссылк[\p{L}\p{N}_-]*\s+в\s+профил[еья]|запис[ьи\p{L}\p{N}_-]*\s+в\s+(?:лс|личк[\p{L}\p{N}_-]*))(?=$|[^\p{L}\p{N}_-]))/iu;
const CROSS_ASSERTION_DEAL_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:скидк[а-и]|бонус|депозит|оплат[аы]|оплатим|платим|вознаграждени[\p{L}\p{N}_-]*|предоплата|бронь|билет[\p{L}\p{N}_-]*|номерок[\p{L}\p{N}_-]*|перевод\s+(?:по\s+номер[у]?|на\s+карт[уы]|оплат[ыа])|обязательн[\p{L}\p{N}_-]*\s+взнос|участи[ея]\s+платн[\p{L}\p{N}_-]*|в\s+наличии|вход\s+(?:по\s+)?инвайт[\p{L}\p{N}_-]*|ответ[\p{L}\p{N}_-]*\s+в\s+комментар[\p{L}\p{N}_-]*|заявк[\p{L}\p{N}_-]*\s+в\s+профил[еья]|принима(?:ю|ем)\s+заказ[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu;
const NEGATION_BEFORE_ACTION_PATTERN = /(?:^|[^\p{L}\p{N}_-])не\s+(?:(?:надо|нужно|стоит)\s+)?$/iu;
const QUOTED_REPORT_INTRO_PATTERN =
  /(?:мошенник[\p{L}\p{N}_-]*|спамер[\p{L}\p{N}_-]*|они|мне|нам)(?:[\p{L}\p{N}\s,()-]{0,60})(?:пишут|прислал[иа]?|рассылают|предлагают|обещают)\s*:/iu;
const CHANNEL_AD_DUE_DILIGENCE_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:кто\s+покупал|покупал[аи]?|брал[аи]?)(?:[\p{L}\p{N}\s.,:;()/%+_"«»—-]{0,80})реклам[\p{L}\p{N}_-]*/iu;
const QUESTION_OR_RECOMMENDATION_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:посоветуйте|подскажите|кто\s+(?:знает|пользовался|обращался|заказывал|занима[её]тся|оказыва(?:ет|ют)|дела(?:ет|ют)|размеща(?:ет|ют)|выда(?:ет|ют)|оформля(?:ет|ют)|ремонтиру(?:ет|ют)|чинит)|где\s+(?:купить|найти|заказать)|ищу\s+(?:мастера|специалиста)|можно\s+ли\s+рекомендовать|рекомендую\s+(?:мастера|специалиста)|(?:мастер|специалист|подрядчик)[\p{L}\p{N}_-]*(?:[\p{L}\p{N}\s.,:;()/%+_-]{0,80})(?:сделал[аи]?|делал[аи]?|ремонтировал[аи]?|помог[лаи]?)(?:[\p{L}\p{N}\s.,:;()/%+_-]{0,32})(?:нам|мне|у\s+нас))(?=$|[^\p{L}\p{N}_-])/iu;
const GROUP_RULES_MODERATION_PATTERN =
  /^(?=[\s\S]{0,800}(?:правил[\p{L}\p{N}_-]*|запрещ[её]н[\p{L}\p{N}_-]*))(?=[\s\S]{0,800}(?:картин[\p{L}\p{N}_-]*|ссылк[\p{L}\p{N}_-]*|спам[\p{L}\p{N}_-]*|реклам[\p{L}\p{N}_-]*))(?=[\s\S]{0,800}(?:нарушени[\p{L}\p{N}_-]*|бан[\p{L}\p{N}_-]*|удал[\p{L}\p{N}_-]*|мут[\p{L}\p{N}_-]*|нельзя))[\s\S]{20,800}$/iu;
const CURRENT_OFFER_RESPONSE_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])запис[ьи\p{L}\p{N}_-]*\s+в\s+(?:лс|личк[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu;
const ATTRIBUTED_RESPONSE_ACTION_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:пишите?|напишите?|звоните?|обращайтесь|свяжитесь)(?:[\p{L}\p{N}\s,:-]{0,32})(?:мне|ему|ей|им|с\s+(?:ним|ней|ними)|мастеру|подрядчику|специалисту|исполнителю)(?=$|[^\p{L}\p{N}_-])/iu;
const OWNED_SOURCE_SIDE_SERVICE_ASSERTION_PATTERN =
  /^[^\p{L}\p{N}_]{0,16}(?:(?:а|но)\s+)?наш[аи]\s+(?:компани[яи]|команд[аы])\s+(?:оказыва(?:ет|ют)|устанавлива(?:ет|ют)|выполня(?:ет|ют)|предлага(?:ет|ют)|предоставля(?:ет|ют)|занима(?:ется|ются)|провод(?:ит|ят)|дела(?:ет|ют)|ремонтиру(?:ет|ют))(?=$|[^\p{L}\p{N}_-])/iu;
const FIRST_PERSON_SOURCE_SIDE_SERVICE_ASSERTION_PATTERN =
  /^[^\p{L}\p{N}_]{0,16}(?:(?:а|но)\s+)?(?:я|мы)\s+(?:предлага(?:ю|ем)|оказыва(?:ю|ем)|помога(?:ю|ем)|дела(?:ю|ем)|провод(?:жу|им)|принима(?:ю|ем)|оформ(?:лю|им)|подбер(?:у|ем)|созда(?:ю|дим)|устанавлива(?:ю|ем)|убира(?:ю|ем)|доставля(?:ю|ем)|поставля(?:ю|ем)|ремонтиру(?:ю|ем))(?=$|[^\p{L}\p{N}_-])/iu;
const FIRST_PERSON_UNAMBIGUOUS_SOURCE_SIDE_SERVICE_ASSERTION_PATTERN =
  /^[^\p{L}\p{N}_]{0,16}(?:(?:а|но)\s+)?(?:я|мы)\s+(?:оказыва(?:ю|ем)|помога(?:ю|ем)|дела(?:ю|ем)|провод(?:жу|им)|оформ(?:лю|им)|созда(?:ю|дим)|устанавлива(?:ю|ем)|убира(?:ю|ем)|доставля(?:ю|ем)|поставля(?:ю|ем)|ремонтиру(?:ю|ем))(?=$|[^\p{L}\p{N}_-])/iu;
const NAMED_SOURCE_SIDE_SERVICE_ASSERTION_PATTERN =
  /^[^\p{L}\p{N}_]{0,16}(?:(?:а|но)\s+)?(?:компани[яи]|ооо|ип)\s+(?:(?:["«][^"»\n]{1,60}["»])|[\p{L}\p{N}_-]{2,40}(?:\s+[\p{L}\p{N}_-]{2,40}){0,3})\s+(?:оказыва(?:ет|ют)|устанавлива(?:ет|ют)|выполня(?:ет|ют)|предлага(?:ет|ют)|предоставля(?:ет|ют)|занима(?:ется|ются)|провод(?:ит|ят)|дела(?:ет|ют)|ремонтиру(?:ет|ют))(?=$|[^\p{L}\p{N}_-])/iu;
const NEGATED_SOURCE_SIDE_SERVICE_ASSERTION_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:больше\s+)?не\s+(?:оказыва(?:ет|ют)|устанавлива(?:ет|ют)|выполня(?:ет|ют)|предлага(?:ет|ют)|предоставля(?:ет|ют)|занима(?:ется|ются)|провод(?:ит|ят)|дела(?:ет|ют)|ремонтиру(?:ет|ют))(?=$|[^\p{L}\p{N}_-])/iu;
const SOURCE_SIDE_SERVICE_NUMERIC_PRICE_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:цен[аы]|стоимост[ьи])\s*(?:от\s*)?\d{2,}|от\s+\d{2,}|\d[\d\s.,]{0,16}\s*(?:р(?:уб(?:ль|ля|лей)?)?\.?|₽))(?=$|[^\p{L}\p{N}_-])/iu;
const SERVICE_RESPONSE_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:звоните|пишите|обращайтесь|записывайтесь)(?![\p{L}\p{N}_-])/iu;
const STRUCTURED_SERVICE_CARD_PATTERN =
  /^(?:только\s+)?(?:монтаж|ремонт|установк[а-яё-]*|химчистк[а-яё-]*|перетяжк[а-яё-]*|чистк[а-яё-]*|заточк[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu;
const EXPLICIT_SERVICE_BOOKING_PATTERN =
  /^(?:(?:я|мы)\s+)?принима(?:ю|ем)\s+заказ[а-яё-]*(?=$|[^\p{L}\p{N}_-])/iu;
const EXPLICIT_SERVICE_CARD_PATTERN = /^(?:услуг[аи]|сервис)\s+[^.!?;\n]{1,160}$/iu;
const THIRD_PARTY_SERVICE_RESPONSE_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:звоните|пишите|обращайтесь|записывайтесь)(?:[^.!?\n]{0,48})(?:ему|ей|им|мастер[а-яё-]*|подрядчик[а-яё-]*|специалист[а-яё-]*|исполнител[а-яё-]*|к\s+(?:нему|ней|ним)|по\s+(?:(?:их|е[её]|его)\s+(?:номеру|телефону)|(?:номеру|телефону)\s+(?:компани[иия]|из\s+объявлени[а-яё-]*)|контакт[а-яё-]*\s+(?:мастер[а-яё-]*|подрядчик[а-яё-]*|специалист[а-яё-]*|исполнител[а-яё-]*)))(?=$|[^\p{L}\p{N}_-])/iu;
const BUYER_SERVICE_RESPONSE_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:звоните|пишите|обращайтесь|записывайтесь)(?:[^.!?\n]{0,32})(?:мне|(?:свои\s+)?предложени[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu;
const DEMAND_SIDE_ESCALATION_FRAME_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:кто\s+(?:выда(?:ет|ют)|оформля(?:ет|ют)|оказыва(?:ет|ют))|ищу|нуж(?:ен|на|но|ны)|подскажите|посоветуйте)(?:[^.!?;\n]{0,140})(?:кредит[а-яё-]*|займ[а-яё-]*|крипт[а-яё-]*|обменник[а-яё-]*|казино|ставк[а-яё-]*)|где(?:[^.!?;\n]{0,100})(?:оформить|получить|найти)(?:[^.!?;\n]{0,80})(?:кредит[а-яё-]*|займ[а-яё-]*))(?=$|[^\p{L}\p{N}_-])/iu;
const BUYER_ESCALATION_EVIDENCE_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:пишите?|присылайте?)(?:[^.!?;\n]{0,40})(?:свои\s+)?предложени[а-яё-]*(?:[^.!?;\n]{0,24})мне|предложени[а-яё-]*(?:[^.!?;\n]{0,40})(?:пишите?|присылайте?)(?:[^.!?;\n]{0,24})мне|мо[ий]\s+(?:телефон|номер)|бюджет(?:[^.!?;\n]{0,40})\d)(?=$|[^\p{L}\p{N}_-])/iu;
const OWNED_TEAM_SERVICE_RESPONSE_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:звоните|пишите|обращайтесь|записывайтесь)(?:[^.!?\n]{0,32})нам(?=$|[^\p{L}\p{N}_-])/iu;
const QUALIFIED_SOURCE_SIDE_PROTECTED_CONTEXT_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:цитир[а-яё-]*|(?:пример|цитат)[а-яё-]*(?:[^.!?\n]{0,40})реклам[а-яё-]*|обзор[еа]?|редакци[яи]|это\s+не\s+предложени[а-яё-]*|чуж[а-яё-]*(?:[^.!?\n]{0,24})объявлени[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu;
const QUALIFIED_EDITORIAL_QUOTE_INTRO_PATTERN =
  /^(?:(?:(?:в\s+)?обзор[еа]?|редакци[яи]|журналист[а-яё-]*)\s+(?:цитир[а-яё-]*|привод[а-яё-]*\s+слов[а-яё-]*)(?:\s+(?:продавц[а-яё-]*|поставщик[а-яё-]*|компани[а-яё-]*))?|(?:в\s+)?инструкци[а-яё-]*\s+разбира[а-яё-]*\s+пример[а-яё-]*\s+реклам[а-яё-]*|модератор[а-яё-]*\s+цитир[а-яё-]*\s+нарушени[а-яё-]*|пример[а-яё-]*\s+запрещ[а-яё-]*\s+реклам[а-яё-]*|(?:в\s+)?учебн[а-яё-]*\s+(?:(?:пример[а-яё-]*|текст[а-яё-]*|материал[а-яё-]*)\s+(?:написан[а-яё-]*|сказан[а-яё-]*|привед[её]н[а-яё-]*)|(?:текст[а-яё-]*|материал[а-яё-]*)[^.!?;\n]{0,80}пример[а-яё-]*))[^«"“„\n]{0,140}[«"“„]/iu;
const QUALIFIED_EDITORIAL_QUOTE_DISCLAIMER_PATTERN =
  /[»"”“]\s*[.!?;…]*\s*(?:(?:это\s+)?цитат[а-яё-]*(?:[^.!?;\n]{0,80})не\s+предложени[а-яё-]*|(?:это\s+)?не\s+предложени[а-яё-]*|(?:это\s+)?нарушени[а-яё-]*(?:[^.!?;\n]{0,100})удал[а-яё-]*)/iu;
const EDITORIAL_QUOTE_DISCLAIMER_ASSERTION_PATTERN =
  /^(?:(?:это\s+)?цитат[а-яё-]*(?:[^.!?;\n]{0,80})не\s+предложени[а-яё-]*|(?:это\s+)?не\s+предложени[а-яё-]*|(?:это\s+)?нарушени[а-яё-]*(?:[^.!?;\n]{0,100})удал[а-яё-]*)\s*$/iu;
const STANDALONE_EDITORIAL_SOURCE_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:исследовани|отч[её]т|доклад|материал)[а-яё-]*|стать(?:я|и|е|ю|ёй|ей)[а-яё-]*|(?:пример|цитат)[а-яё-]*\s+реклам[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu;
const STANDALONE_EDITORIAL_SUBJECT_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:реклам|объявлен|предложен|мошеннич)[а-яё-]*(?=$|[^\p{L}\p{N}_-])/iu;
const STANDALONE_EDITORIAL_EXAMPLE_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:пример|цитат)[а-яё-]*(?=$|[^\p{L}\p{N}_-])/iu;
const STANDALONE_EDITORIAL_PRESENTATION_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:привод|привед[её]н|содерж|разбира|показыва|публику)[а-яё-]*|дан(?:а|о|ы)?)(?=$|[^\p{L}\p{N}_-])/iu;
const ATTRIBUTED_AD_EXAMPLE_INTRO_PATTERN =
  /^[^.!?;\n…。！？；]{0,160}?(?:(?:цитир[а-яё-]*|привод[а-яё-]*)(?:[^.!?\n]{0,80})(?:пример[а-яё-]*\s+реклам[а-яё-]*|реклам[а-яё-]*\s+(?:пример|текст)[а-яё-]*)|(?:в\s+)?стать[еяи](?:[^.!?\n]{0,80})(?:привед[её]н[а-яё-]*|опубликован[а-яё-]*)(?:[^.!?\n]{0,48})пример[а-яё-]*\s+реклам[а-яё-]*)/iu;
const ATTRIBUTED_THIRD_PARTY_INTRO_PATTERN =
  /^[^.!?;\n…。！？；]{0,160}?(?:сосед[а-яё-]*(?:[^.!?\n]{0,48})(?:сказал[а-яё-]*|сообщил[а-яё-]*|рассказал[а-яё-]*|рекоменду[а-яё-]*|совету[а-яё-]*)|мастер[а-яё-]*(?:[^.!?\n]{0,80})пишет(?:[^.!?\n]{0,48})объявлени[а-яё-]*)/iu;
const ATTRIBUTED_EDITORIAL_INTRO_PATTERN =
  /^[^.!?;\n…。！？；]{0,160}?(?:по\s+данн[а-яё-]*\s+обзор[а-яё-]*|(?:в\s+)?обзор[еа]?(?:[^.!?\n]{0,80})редакци[яи](?:[^.!?\n]{0,48})упомина[а-яё-]*|обсуждал[а-яё-]*(?:[^.!?\n]{0,48})в\s+обзор[еа]?)/iu;
const ATTRIBUTED_AD_EXAMPLE_QUALIFIER_PATTERN =
  /(?:не\s+предложени[а-яё-]*|это\s+цитат[а-яё-]*|чуж[а-яё-]*\s+объявлени[а-яё-]*)/iu;
const ATTRIBUTED_THIRD_PARTY_QUALIFIER_PATTERN =
  /(?:пишите?\s+(?:ей|ему|им)|телефон[а-яё-]*\s+(?:поставщик[а-яё-]*|продавц[а-яё-]*)|контакт[а-яё-]*\s+продавц[а-яё-]*|ничего\s+не\s+прода[а-яё-]*|не\s+продавец|чуж[а-яё-]*\s+объявлени[а-яё-]*)/iu;
const ATTRIBUTED_EDITORIAL_QUALIFIER_PATTERN =
  /(?:редакци[яи](?:[^.!?\n]{0,48})ничего\s+не\s+прода[а-яё-]*|это\s+не\s+реклам[а-яё-]*|дословно(?:[^.!?\n]{0,48})цитир[а-яё-]*(?:[^.!?\n]{0,32})реклам[а-яё-]*|не\s+предложени[а-яё-]*)/iu;
const ATTRIBUTED_REPORT_QUALIFIER_PREFILTER =
  /(?:не\s+предложени[а-яё-]*|это\s+цитат[а-яё-]*|чуж[а-яё-]*\s+объявлени[а-яё-]*|пишите?\s+(?:ей|ему|им)|телефон[а-яё-]*\s+(?:поставщик[а-яё-]*|продавц[а-яё-]*)|контакт[а-яё-]*\s+продавц[а-яё-]*|ничего\s+не\s+прода[а-яё-]*|не\s+продавец|это\s+не\s+реклам[а-яё-]*|дословно(?:[^.!?\n]{0,48})цитир[а-яё-]*)/iu;
const DEMAND_SIDE_SERVICE_FRAME_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:сломал[асоь]?|сломан[аыо]?|не\s+работает|перестал[аи]?\s+работать)(?:[\p{L}\p{N}\s,:-]{0,80})(?:холодильник[\p{L}\p{N}_-]*|техник[\p{L}\p{N}_-]*|телефон[\p{L}\p{N}_-]*|машин[а-яё-]*|окн[а-яё-]*|двер[а-яё-]*)|(?:бюджет|объ[её]м)\s*[:,-]?\s*(?:\d+(?:[.,]\d+)?|\[price\])|(?:нуж(?:ен|на|но|ны)|требуется)(?:[\p{L}\p{N}\s,:-]{0,48})(?:ремонт|мастер|специалист))(?=$|[^\p{L}\p{N}_-])/iu;
const QUOTED_AD_EXAMPLE_FRAME_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:цитир[\p{L}\p{N}_-]*|привод[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s,:«»"'-]{0,80})пример[\p{L}\p{N}_-]*(?:\s+реклам[\p{L}\p{N}_-]*)?|(?:образец|пример)[\p{L}\p{N}_-]*\s+реклам[\p{L}\p{N}_-]*[\s,«»"':-]{0,32}(?:а\s+)?не\s+предложени[\p{L}\p{N}_-]*|не\s+предложени[\p{L}\p{N}_-]*[\s,«»"':-]{0,32}а\s+(?:образец|пример)[\p{L}\p{N}_-]*\s+реклам[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu;
const FUEL_PRICE_EDITORIAL_ASSERTION_PATTERN =
  /^(?=[\s\S]{0,700}(?:по\s+данн[\p{L}\p{N}_-]*|мониторинг[\p{L}\p{N}_-]*|обзор[\p{L}\p{N}_-]*))(?=[\s\S]{0,700}(?:бензин[\p{L}\p{N}_-]*|дизел[\p{L}\p{N}_-]*|топлив[\p{L}\p{N}_-]*|аи(?:[\s\p{Pd}-])?(?:80|92|95|98|100)|(?:^|[^\p{L}\p{N}_-])дт(?=$|[^\p{L}\p{N}_-])))(?=[\s\S]{0,700}(?:цен[аы][\p{L}\p{N}_-]*|стоимост[\p{L}\p{N}_-]*|подорожал[\p{L}\p{N}_-]*|подешевел[\p{L}\p{N}_-]*|вырос[\p{L}\p{N}_-]*|снизил[\p{L}\p{N}_-]*))\s*[\s\S]+$/iu;
const ATTRIBUTED_COMMERCIAL_QUOTE_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:представител[\p{L}\p{N}_-]*|поставщик[\p{L}\p{N}_-]*|продавец[\p{L}\p{N}_-]*|эксперт[\p{L}\p{N}_-]*|аналитик[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s,()-]{0,80})(?:сообщил[\p{L}\p{N}_-]*|заявил[\p{L}\p{N}_-]*|рассказал[\p{L}\p{N}_-]*|отметил[\p{L}\p{N}_-]*|пояснил[\p{L}\p{N}_-]*)\s*[:,-]?\s*[«"“„](?=$|[\p{L}\p{N}_-])/iu;
const EXPLICIT_FUEL_SELLER_OFFER_PATTERN =
  /^(?=[\s\S]{0,700}(?:прода(?:ю|ем|[её]т|ют)|предлага(?:ю|ем|ет|ют)|реализу(?:ю|ем|ет|ют)|поставля(?:ю|ем|ет|ют)|(?:в|на)\s+наш(?:ем|ей)\s+(?:магазин[а-яё-]*|азс)|у\s+нас))(?=[\s\S]{0,700}(?:бензин[а-яё-]*|дизел[а-яё-]*|топлив[а-яё-]*|аи(?:[\s\p{Pd}-])?(?:80|92|95|98|100)|(?:^|[^\p{L}\p{N}_-])дт(?=$|[^\p{L}\p{N}_-])))(?=[\s\S]{0,700}(?:\d+[\d\s.,]{0,8}\s*(?:₽|р(?:уб)?)|опт[а-яё-]*|розниц[а-яё-]*|скидк[а-яё-]*|закаж[а-яё-]*|пишите?|звон[а-яё-]*|\[phone\]))[\s\S]+$/iu;

const GENERAL_COMMERCIAL_PATTERNS: readonly CommercialLabeledPattern[] = [
  ...ADS_BUSINESS_PATTERNS,
  ...ADS_BUYOUT_PATTERNS,
  ...ADS_CHANNEL_PLACEMENT_PATTERNS,
  ...ADS_GOODS_RETAIL_PATTERNS,
  ...ADS_PROPERTY_AGENT_PATTERNS,
  ...ADS_PROPERTY_COMMERCIAL_PATTERNS,
  ...ADS_RECRUITMENT_PATTERNS,
  ...ADS_SERVICE_OFFER_PATTERNS,
  ...ADS_SERVICE_SPECIALTY_PATTERNS,
];
const PROTECTED_PRIVATE_LISTING_PATTERNS: readonly CommercialLabeledPattern[] = [
  ...ADS_PRIVATE_SINGLE_LISTING_PATTERNS,
  ...ADS_PRIVATE_GOODS_PATTERNS,
];

export function hasQualifiedSourceSideServiceOffer(text: string): boolean {
  const boundedText = text.toLowerCase().slice(0, MAX_LOCAL_CONTEXT_LENGTH);
  if (
    !SOURCE_SIDE_SERVICE_NUMERIC_PRICE_PATTERN.test(boundedText) ||
    !SERVICE_RESPONSE_PATTERN.test(boundedText)
  ) {
    return false;
  }
  const assertions = splitCommercialAssertions(boundedText);
  for (let index = 0; index < assertions.length; index += 1) {
    const sourceAssertion = assertions[index];
    if (
      isQuestionAssertion(sourceAssertion) ||
      isProtectedAssertion(sourceAssertion) ||
      QUALIFIED_SOURCE_SIDE_PROTECTED_CONTEXT_PATTERN.test(sourceAssertion)
    ) {
      continue;
    }
    const hasOwnedSource =
      hasNonNegatedSourceSideServiceFrame(
        sourceAssertion,
        OWNED_SOURCE_SIDE_SERVICE_ASSERTION_PATTERN,
      ) ||
      hasNonNegatedSourceSideServiceFrame(
        sourceAssertion,
        FIRST_PERSON_SOURCE_SIDE_SERVICE_ASSERTION_PATTERN,
      );
    if (
      !hasOwnedSource &&
      !hasNonNegatedSourceSideServiceFrame(
        sourceAssertion,
        NAMED_SOURCE_SIDE_SERVICE_ASSERTION_PATTERN,
      )
    ) {
      continue;
    }

    const windowParts = [sourceAssertion];
    for (let offset = 1; offset < 3 && index + offset < assertions.length; offset += 1) {
      const nextAssertion = assertions[index + offset];
      if (
        isQuestionAssertion(nextAssertion) ||
        REPORTING_OR_ATTRIBUTION_PATTERN.test(nextAssertion) ||
        QUESTION_OR_RECOMMENDATION_PATTERN.test(nextAssertion) ||
        DEMAND_SIDE_SERVICE_FRAME_PATTERN.test(nextAssertion)
      ) {
        break;
      }
      const nextWindow = `${windowParts.join('. ')}. ${nextAssertion}`;
      if (nextWindow.length > MAX_LOCAL_WINDOW_LENGTH) {
        break;
      }
      windowParts.push(nextAssertion);
    }

    const window = windowParts.join('. ');
    if (
      SOURCE_SIDE_SERVICE_NUMERIC_PRICE_PATTERN.test(window) &&
      hasUnattributedServiceResponse(
        window,
        true,
        FIRST_PERSON_UNAMBIGUOUS_SOURCE_SIDE_SERVICE_ASSERTION_PATTERN.test(sourceAssertion),
      )
    ) {
      return true;
    }
  }
  return false;
}

export function hasExplicitServiceBookingCard(text: string): boolean {
  if (text.length > MAX_LOCAL_WINDOW_LENGTH) return false;
  const inspection = inspectCommercialAssertions(text.toLowerCase());
  if (!inspection.complete) return false;
  const assertions = inspection.assertions;
  if (
    assertions.some(
      (assertion) =>
        resolveCommercialServiceSpeechAct(assertion) !== 'NONE' || isProtectedAssertion(assertion),
    )
  )
    return false;
  for (let index = 0; index < assertions.length; index += 1) {
    const source = assertions[index]!;
    const normalizedSource = normalizeCommercialText(source);
    if (
      !EXPLICIT_SERVICE_CARD_PATTERN.test(source) ||
      (!ADS_SERVICE_SPECIALTY_PATTERNS.some(({ pattern }) => testPattern(pattern, source)) &&
        !ADS_SERVICE_SPECIALTY_MARKERS.some((marker) => normalizedSource.includes(marker)))
    )
      continue;
    const tail = assertions.slice(index + 1, index + 4);
    if (!tail.some((assertion) => EXPLICIT_SERVICE_BOOKING_PATTERN.test(assertion))) continue;
    const window = [source, ...tail].join('. ');
    if (
      hasCommercialPhoneLikeText(window) ||
      ADS_CONTEXTUAL_PHONE_PLACEHOLDER_PATTERN.test(window) ||
      ADS_HANDLE_CONTACT_PATTERN.test(window)
    )
      return true;
  }
  return false;
}

export function hasUnattributedServiceResponse(
  text: string,
  allowOwnedTeamTarget = false,
  allowFirstPersonTarget = false,
): boolean {
  return (
    SERVICE_RESPONSE_PATTERN.test(text) &&
    hasNonNegatedAffirmativeAction(text) &&
    !THIRD_PARTY_SERVICE_RESPONSE_PATTERN.test(text) &&
    (allowFirstPersonTarget || !BUYER_SERVICE_RESPONSE_PATTERN.test(text)) &&
    (allowOwnedTeamTarget || !OWNED_TEAM_SERVICE_RESPONSE_PATTERN.test(text))
  );
}

type LocalAssertion = {
  text: string;
  normalizedText: string;
  protectedFrame: boolean;
  parts?: readonly LocalAssertion[];
};

export type CommercialLocalContext = {
  fullyInspected: boolean;
  hasIndependentCommercialOffer: boolean;
  hasIndependentEscalationOffer: boolean;
  hasOnlyProtectedEscalationMentions: boolean;
  hasProtectedContext: boolean;
  independentCommercialOfferText: string | null;
  hasAttributedCommercialReport: boolean;
  hasStandaloneEditorialQuote: boolean;
};

export function resolveCommercialLocalContext(params: {
  rawLoweredText: string;
  escalationRiskLabels: readonly string[];
  includeOrdinaryProtectedContext?: boolean;
  forceInspection?: boolean;
}): CommercialLocalContext {
  const includeOrdinaryProtectedContext = params.includeOrdinaryProtectedContext === true;
  const requireQualifiedRiskProtection = params.escalationRiskLabels.length > 0;
  const boundedRawLoweredText = params.rawLoweredText.slice(0, MAX_LOCAL_CONTEXT_LENGTH);
  const mightHaveAttributedCommercialReport =
    ADS_ATTRIBUTED_COMMERCIAL_FRAME_PATTERN.test(boundedRawLoweredText) &&
    ATTRIBUTED_REPORT_QUALIFIER_PREFILTER.test(boundedRawLoweredText);
  const hasQualifiedEditorialQuoteDisclaimer =
    QUALIFIED_EDITORIAL_QUOTE_DISCLAIMER_PATTERN.test(boundedRawLoweredText);
  const initialInspection =
    mightHaveAttributedCommercialReport || hasQualifiedEditorialQuoteDisclaimer
      ? inspectCommercialAssertions(params.rawLoweredText)
      : null;
  const assertionTexts = initialInspection?.assertions ?? null;
  const attributedCommercialReportAssertionIndexes = assertionTexts
    ? collectAttributedCommercialReportAssertionIndexes(assertionTexts)
    : new Set<number>();
  const hasAttributedCommercialReport = attributedCommercialReportAssertionIndexes.size > 0;
  const standaloneEditorialQuoteAssertionIndexes = assertionTexts
    ? collectStandaloneEditorialQuoteAssertionIndexes(assertionTexts)
    : new Set<number>();
  const hasStandaloneEditorialQuote = standaloneEditorialQuoteAssertionIndexes.size > 0;
  if (
    !params.forceInspection &&
    params.escalationRiskLabels.length === 0 &&
    !hasAttributedCommercialReport &&
    !hasQualifiedEditorialQuoteDisclaimer &&
    !isProtectedAssertion(boundedRawLoweredText, requireQualifiedRiskProtection) &&
    !CHANNEL_AD_DUE_DILIGENCE_PATTERN.test(boundedRawLoweredText) &&
    !(includeOrdinaryProtectedContext && isOrdinaryProtectedAssertion(boundedRawLoweredText))
  ) {
    return {
      fullyInspected: false,
      hasIndependentCommercialOffer: false,
      hasIndependentEscalationOffer: false,
      hasOnlyProtectedEscalationMentions: false,
      hasProtectedContext: false,
      independentCommercialOfferText: null,
      hasAttributedCommercialReport: false,
      hasStandaloneEditorialQuote: false,
    };
  }

  const riskPatterns = selectRiskPatterns(params.escalationRiskLabels);
  const inspection = initialInspection ?? inspectCommercialAssertions(params.rawLoweredText);
  const assertions = classifyAssertions(
    inspection.assertions,
    riskPatterns,
    includeOrdinaryProtectedContext,
    attributedCommercialReportAssertionIndexes,
    standaloneEditorialQuoteAssertionIndexes,
  );
  const independentEscalationOffer = findOfferInUnprotectedWindow(assertions, (window) =>
    hasEscalationOffer(window, riskPatterns),
  );
  const independentCommercialOffer =
    independentEscalationOffer ??
    findOfferInUnprotectedWindow(assertions, (window) => hasGeneralCommercialOffer(window));
  const hasIndependentEscalationOffer = independentEscalationOffer !== null;
  const hasIndependentCommercialOffer = independentCommercialOffer !== null;
  const hasProtectedEscalationMention = assertions.some(
    (assertion) => assertion.protectedFrame && hasRiskPattern(assertion, riskPatterns),
  );

  return {
    fullyInspected: inspection.complete,
    hasIndependentCommercialOffer,
    hasIndependentEscalationOffer,
    hasOnlyProtectedEscalationMentions:
      riskPatterns.length > 0 && !hasIndependentEscalationOffer && hasProtectedEscalationMention,
    hasProtectedContext: assertions.some((assertion) => assertion.protectedFrame),
    independentCommercialOfferText: independentCommercialOffer?.text ?? null,
    hasAttributedCommercialReport,
    hasStandaloneEditorialQuote,
  };
}

export function resolveStandaloneEditorialQuoteContext(params: {
  rawLoweredText: string;
  escalationRiskLabels: readonly string[];
  includeOrdinaryProtectedContext?: boolean;
}): CommercialLocalContext | null {
  if (
    !QUALIFIED_EDITORIAL_QUOTE_DISCLAIMER_PATTERN.test(
      params.rawLoweredText.slice(0, MAX_LOCAL_CONTEXT_LENGTH),
    )
  ) {
    return null;
  }

  const context = resolveCommercialLocalContext(params);
  return context.hasStandaloneEditorialQuote ? context : null;
}

export function splitCommercialAssertions(rawLoweredText: string): string[] {
  return inspectCommercialAssertions(rawLoweredText).assertions;
}

export type CommercialAssertionInspection = Readonly<{
  assertions: string[];
  complete: boolean;
}>;

export function inspectCommercialAssertions(
  rawLoweredText: string,
): CommercialAssertionInspection {
  const boundedText = rawLoweredText
    .slice(0, MAX_LOCAL_CONTEXT_LENGTH)
    .replace(CLOSING_QUOTE_ASSERTION_BOUNDARY, '$1$2\n')
    .replace(QUESTION_ASSERTION_BOUNDARY, '$1$2\n');

  const assertions = insertNoSpaceDotAssertionBoundaries(boundedText)
    .replace(CONTRASTIVE_SELF_PROMO_BOUNDARY, '\n')
    .replace(COMMERCIAL_SERVICE_CONTRAST_BOUNDARY, '\n')
    .replace(COMMERCIAL_CANDIDATE_SERVICE_CONTRAST_BOUNDARY, '\n')
    .split(ASSERTION_BOUNDARY)
    .flatMap(splitWarningPrefixedSelfPromo)
    .map((assertion) => assertion.trim())
    .filter(Boolean);
  return {
    assertions: bindStandaloneEditorialQuoteAssertions(assertions.slice(0, MAX_LOCAL_ASSERTIONS)),
    // FLAG: Count before quote grouping; merging truncated assertions cannot restore coverage.
    complete:
      rawLoweredText.length <= MAX_LOCAL_CONTEXT_LENGTH &&
      assertions.length <= MAX_LOCAL_ASSERTIONS,
  };
}

function bindStandaloneEditorialQuoteAssertions(assertions: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < assertions.length; index += 1) {
    const quote = assertions[index + 1];
    const disclaimer = assertions[index + 2];
    if (
      quote !== undefined &&
      disclaimer !== undefined &&
      isQualifiedStandaloneEditorialQuoteIntro(assertions[index]) &&
      isClosedStandaloneEditorialQuote(quote) &&
      EDITORIAL_QUOTE_DISCLAIMER_ASSERTION_PATTERN.test(disclaimer)
    ) {
      result.push(`${assertions[index]}. ${quote}`);
      index += 1;
      continue;
    }
    result.push(assertions[index]);
  }
  return result;
}

function splitWarningPrefixedSelfPromo(assertion: string): string[] {
  WARNING_PREFIX_SELF_PROMO_BOUNDARY.lastIndex = 0;
  for (const match of assertion.matchAll(WARNING_PREFIX_SELF_PROMO_BOUNDARY)) {
    const boundaryIndex = match.index ?? -1;
    if (boundaryIndex < 0) {
      continue;
    }
    const prefix = assertion.slice(0, boundaryIndex).trim();
    if (
      !COMPLAINT_OR_WARNING_PATTERN.test(prefix) ||
      REPORTING_OR_ATTRIBUTION_PATTERN.test(prefix)
    ) {
      continue;
    }
    return [prefix, assertion.slice(boundaryIndex + match[0].length).trim()];
  }
  return [assertion];
}

function classifyAssertions(
  assertionTexts: readonly string[],
  riskPatterns: readonly CommercialLabeledPattern[],
  includeOrdinaryProtectedContext: boolean,
  attributedCommercialReportAssertionIndexes: ReadonlySet<number>,
  standaloneEditorialQuoteAssertionIndexes: ReadonlySet<number>,
): LocalAssertion[] {
  const assertions: LocalAssertion[] = [];
  let protectedCarry = 0;
  let protectedQuoteDelimiters: ProtectedQuoteDelimiter[] = [];
  let ordinaryProtectedCarry = false;
  let ordinaryProtectedSpeechAct: CommercialServiceSpeechAct = 'NONE';

  for (let index = 0; index < assertionTexts.length; index += 1) {
    const text = assertionTexts[index];
    const protectedQuote = protectedQuoteDelimiters.length > 0;
    const normalizedText = normalizeCommercialText(text);
    const qualifiedEditorialQuote =
      standaloneEditorialQuoteAssertionIndexes.has(index) ||
      hasQualifiedEditorialQuoteContext(assertionTexts, index);
    const attributedCommercialReport = attributedCommercialReportAssertionIndexes.has(index);
    const intrinsicProtected =
      isProtectedAssertion(text, riskPatterns.length > 0) ||
      qualifiedEditorialQuote ||
      attributedCommercialReport ||
      EDITORIAL_QUOTE_DISCLAIMER_ASSERTION_PATTERN.test(text) ||
      (riskPatterns.length > 0 && hasQualifiedEditorialRiskContext(assertionTexts, index));
    const intrinsicOrdinaryProtected =
      includeOrdinaryProtectedContext &&
      (attributedCommercialReport || isOrdinaryProtectedAssertion(text));
    const serviceSpeechAct = includeOrdinaryProtectedContext
      ? resolveCommercialServiceSpeechAct(text)
      : 'NONE';
    const rawAssertion = { text, normalizedText, protectedFrame: false };
    let resetsOrdinaryProtectedCarry = false;
    if (ordinaryProtectedCarry) {
      const ordinaryResetWindow = buildForwardAssertionWindow(assertionTexts, index);
      const hasExplicitSelfPromotion =
        SELF_PROMO_RESET_PATTERN.test(text) || COMMERCIAL_OWNED_SERVICE_FRAME.test(text);
      const hasExplicitSourceSideOffer = ADS_EXPLICIT_SOURCE_SIDE_PROMO_FRAME_PATTERN.test(text);
      const hasCurrentCommercialOffer =
        hasGeneralCommercialOffer(ordinaryResetWindow) ||
        hasEscalationOffer(ordinaryResetWindow, riskPatterns);
      const hasUnattributedCurrentAction =
        hasNonNegatedAffirmativeAction(ordinaryResetWindow.text) &&
        !ATTRIBUTED_RESPONSE_ACTION_PATTERN.test(ordinaryResetWindow.text) &&
        !THIRD_PARTY_SERVICE_RESPONSE_PATTERN.test(ordinaryResetWindow.text) &&
        !BUYER_SERVICE_RESPONSE_PATTERN.test(ordinaryResetWindow.text);
      const hasCurrentResponseChannel = CURRENT_OFFER_RESPONSE_PATTERN.test(
        ordinaryResetWindow.text,
      );
      resetsOrdinaryProtectedCarry =
        hasCurrentCommercialOffer &&
        // FLAG: A complaint's third-party price/contact is not an author's independent offer.
        (ordinaryProtectedSpeechAct !== 'COMPLAINT' ||
          hasExplicitSourceSideOffer ||
          COMMERCIAL_OWNED_SERVICE_FRAME.test(text)) &&
        (hasExplicitSelfPromotion ||
          hasExplicitSourceSideOffer ||
          ((!DEMAND_SIDE_SERVICE_FRAME_PATTERN.test(ordinaryResetWindow.text) ||
            hasExplicitSelfPromotion) &&
            (hasUnattributedCurrentAction || hasCurrentResponseChannel)));
    }
    const resetsProtectedCarry =
      protectedCarry > 0 &&
      (SELF_PROMO_RESET_PATTERN.test(text) ||
        COMMERCIAL_OWNED_SERVICE_FRAME.test(text) ||
        ADS_EXPLICIT_SOURCE_SIDE_PROMO_FRAME_PATTERN.test(text) ||
        (!intrinsicProtected &&
          (hasEscalationOffer(rawAssertion, riskPatterns) ||
            hasGeneralCommercialOffer(rawAssertion))));
    const protectedFrame =
      intrinsicProtected ||
      intrinsicOrdinaryProtected ||
      protectedQuote ||
      (protectedCarry > 0 && !resetsProtectedCarry) ||
      (ordinaryProtectedCarry && !resetsOrdinaryProtectedCarry);

    assertions.push({ text, normalizedText, protectedFrame });

    const canOpenProtectedQuote =
      (intrinsicProtected || protectedQuote) &&
      (QUOTED_REPORT_INTRO_PATTERN.test(text) ||
        QUOTED_AD_EXAMPLE_FRAME_PATTERN.test(text) ||
        qualifiedEditorialQuote);
    if (protectedQuote) {
      protectedQuoteDelimiters = scanProtectedQuoteDelimiters(text, protectedQuoteDelimiters);
    } else if (canOpenProtectedQuote) {
      protectedQuoteDelimiters = scanProtectedQuoteDelimiters(text);
    }

    if (intrinsicProtected && PROTECTED_FRAME_CARRY_PATTERN.test(text)) {
      protectedCarry = 2;
    } else if (resetsProtectedCarry) {
      protectedCarry = 0;
    } else if (protectedCarry > 0) {
      protectedCarry -= 1;
    }

    if (intrinsicOrdinaryProtected) {
      ordinaryProtectedCarry = true;
      if (serviceSpeechAct !== 'NONE') ordinaryProtectedSpeechAct = serviceSpeechAct;
    } else if (resetsOrdinaryProtectedCarry) {
      ordinaryProtectedCarry = false;
      ordinaryProtectedSpeechAct = 'NONE';
    }
  }

  return assertions;
}

function buildForwardAssertionWindow(
  assertionTexts: readonly string[],
  startIndex: number,
): LocalAssertion {
  const parts: LocalAssertion[] = [];
  let text = '';
  let normalizedText = '';

  for (
    let index = startIndex;
    index < assertionTexts.length && index < startIndex + MAX_LOCAL_WINDOW_ASSERTIONS;
    index += 1
  ) {
    const partText = assertionTexts[index];
    const partNormalizedText = normalizeCommercialText(partText);
    const nextText = text ? `${text}. ${partText}` : partText;
    if (nextText.length > MAX_LOCAL_WINDOW_LENGTH) {
      break;
    }
    text = nextText;
    normalizedText = normalizedText
      ? `${normalizedText}. ${partNormalizedText}`
      : partNormalizedText;
    parts.push({ text: partText, normalizedText: partNormalizedText, protectedFrame: false });
  }

  return { text, normalizedText, protectedFrame: false, parts };
}

function isProtectedAssertion(text: string, requireQualifiedAttribution = false): boolean {
  const hasStrongProtection =
    PROHIBITED_ACTION_PATTERN.test(text) ||
    LOCAL_REPORTING_FRAME_PATTERN.test(text) ||
    COMPLAINT_OR_WARNING_PATTERN.test(text) ||
    EDITORIAL_CONTACT_PATTERN.test(text) ||
    GROUP_RULES_MODERATION_PATTERN.test(text) ||
    ADS_QUALIFIED_EDITORIAL_QUOTE_PATTERN.test(text) ||
    FUEL_PRICE_EDITORIAL_ASSERTION_PATTERN.test(text) ||
    PUBLIC_HELP_ASSERTION_PATTERN.test(text);
  if (hasStrongProtection) {
    return true;
  }

  if (requireQualifiedAttribution) {
    const hasExplicitBadActorAttribution =
      /(?:^|[^\p{L}\p{N}_-])(?:мошенник[а-яё-]*|спамер[а-яё-]*)\s+(?:звонят|пишут|предлагают|обещают|рассылают|присылают)(?=$|[^\p{L}\p{N}_-])/iu.test(
        text,
      );
    return hasExplicitBadActorAttribution;
  }

  return (
    REPORTING_OR_ATTRIBUTION_PATTERN.test(text) ||
    QUOTED_AD_EXAMPLE_FRAME_PATTERN.test(text) ||
    ADS_ATTRIBUTED_COMMERCIAL_FRAME_PATTERN.test(text) ||
    ATTRIBUTED_COMMERCIAL_QUOTE_PATTERN.test(text)
  );
}

type AttributedCommercialReportIntro = {
  end: number;
  qualifierPattern: RegExp;
};

function collectAttributedCommercialReportAssertionIndexes(
  assertionTexts: readonly string[],
): ReadonlySet<number> {
  const joinedAssertions = assertionTexts.join('\n');
  const assertionOffsets: number[] = [];
  let offset = 0;
  for (const assertion of assertionTexts) {
    assertionOffsets.push(offset);
    offset += assertion.length + 1;
  }

  const result = new Set<number>();
  for (let index = 0; index < assertionTexts.length; index += 1) {
    const intro = resolveAttributedCommercialReportIntro(assertionTexts[index]);
    if (!intro) {
      continue;
    }
    const qualifierWindowStart = assertionOffsets[index] + intro.end;
    const qualifierWindow = joinedAssertions.slice(
      qualifierWindowStart,
      qualifierWindowStart + MAX_ATTRIBUTED_REPORT_WINDOW_LENGTH,
    );
    if (intro.qualifierPattern.test(qualifierWindow)) {
      result.add(index);
    }
  }
  return result;
}

function resolveAttributedCommercialReportIntro(
  assertion: string,
): AttributedCommercialReportIntro | null {
  for (const [pattern, qualifierPattern] of [
    [ATTRIBUTED_AD_EXAMPLE_INTRO_PATTERN, ATTRIBUTED_AD_EXAMPLE_QUALIFIER_PATTERN],
    [ATTRIBUTED_THIRD_PARTY_INTRO_PATTERN, ATTRIBUTED_THIRD_PARTY_QUALIFIER_PATTERN],
    [ATTRIBUTED_EDITORIAL_INTRO_PATTERN, ATTRIBUTED_EDITORIAL_QUALIFIER_PATTERN],
  ] as const) {
    const match = pattern.exec(assertion);
    if (match) {
      return { end: match[0].length, qualifierPattern };
    }
  }
  return null;
}

function hasQualifiedEditorialQuoteContext(
  assertionTexts: readonly string[],
  index: number,
): boolean {
  const previousAssertion = assertionTexts[index - 1];
  const introWindow = previousAssertion
    ? `${previousAssertion}. ${assertionTexts[index]}`.slice(0, 400)
    : assertionTexts[index];
  const introStartsAtPreviousAssertion =
    Boolean(previousAssertion) && QUALIFIED_EDITORIAL_QUOTE_INTRO_PATTERN.test(introWindow);
  if (
    !introStartsAtPreviousAssertion &&
    !QUALIFIED_EDITORIAL_QUOTE_INTRO_PATTERN.test(assertionTexts[index])
  ) {
    return false;
  }

  let window = '';
  const startIndex = introStartsAtPreviousAssertion ? index - 1 : index;
  for (
    let cursor = startIndex;
    cursor < assertionTexts.length && cursor < startIndex + 12;
    cursor += 1
  ) {
    const nextWindow = window ? `${window}. ${assertionTexts[cursor]}` : assertionTexts[cursor];
    if (nextWindow.length > 1_400) {
      break;
    }
    window = nextWindow;
    if (QUALIFIED_EDITORIAL_QUOTE_DISCLAIMER_PATTERN.test(window)) {
      return true;
    }
  }
  return false;
}

function collectStandaloneEditorialQuoteAssertionIndexes(
  assertionTexts: readonly string[],
): ReadonlySet<number> {
  const result = new Set<number>();
  for (let disclaimerIndex = 1; disclaimerIndex < assertionTexts.length; disclaimerIndex += 1) {
    if (!EDITORIAL_QUOTE_DISCLAIMER_ASSERTION_PATTERN.test(assertionTexts[disclaimerIndex])) {
      continue;
    }

    const quoteIndex = disclaimerIndex - 1;
    const introIndex = quoteIndex - 1;
    if (
      isQualifiedCombinedStandaloneEditorialQuote(assertionTexts[quoteIndex]) ||
      (introIndex >= 0 &&
        isQualifiedStandaloneEditorialQuoteIntro(assertionTexts[introIndex]) &&
        isClosedStandaloneEditorialQuote(assertionTexts[quoteIndex]))
    ) {
      result.add(quoteIndex);
    }
  }
  return result;
}

function isQualifiedStandaloneEditorialQuoteIntro(text: string): boolean {
  return (
    text.length <= MAX_STANDALONE_EDITORIAL_INTRO_LENGTH &&
    !/[«"“„]/u.test(text) &&
    STANDALONE_EDITORIAL_SOURCE_PATTERN.test(text) &&
    STANDALONE_EDITORIAL_SUBJECT_PATTERN.test(text) &&
    STANDALONE_EDITORIAL_EXAMPLE_PATTERN.test(text) &&
    STANDALONE_EDITORIAL_PRESENTATION_PATTERN.test(text)
  );
}

function isClosedStandaloneEditorialQuote(text: string): boolean {
  if (text.length > MAX_STANDALONE_EDITORIAL_QUOTE_LENGTH) {
    return false;
  }

  const quote = text
    .trim()
    .replace(/[.!?…]+$/u, '')
    .trimEnd();
  const hasMatchingOuterDelimiters =
    (quote.startsWith('«') && quote.endsWith('»')) ||
    (quote.startsWith('„') && quote.endsWith('“')) ||
    (quote.startsWith('“') && quote.endsWith('”')) ||
    (quote.startsWith('"') && quote.endsWith('"'));
  return hasMatchingOuterDelimiters && scanProtectedQuoteDelimiters(quote).length === 0;
}

function isQualifiedCombinedStandaloneEditorialQuote(text: string): boolean {
  const openingQuoteIndex = text.search(/[«"“„]/u);
  if (openingQuoteIndex <= 0) {
    return false;
  }
  const intro = text.slice(0, openingQuoteIndex).replace(/[.\s]+$/u, '');
  const quote = text.slice(openingQuoteIndex);
  return isQualifiedStandaloneEditorialQuoteIntro(intro) && isClosedStandaloneEditorialQuote(quote);
}

function hasQualifiedEditorialRiskContext(
  assertionTexts: readonly string[],
  index: number,
): boolean {
  const text = assertionTexts[index];
  if (QUALIFIED_EDITORIAL_RISK_ASSERTION_PATTERN.test(text)) {
    return true;
  }

  const nextAssertion = assertionTexts[index + 1];
  return (
    EDITORIAL_RISK_INTRO_PATTERN.test(text) &&
    nextAssertion !== undefined &&
    EDITORIAL_RISK_FOLLOWUP_PATTERN.test(nextAssertion)
  );
}

function isOrdinaryProtectedAssertion(text: string): boolean {
  return (
    resolveCommercialServiceSpeechAct(text) !== 'NONE' ||
    TRANSPORT_DEMAND_PATTERN.test(text) ||
    CHANNEL_AD_DUE_DILIGENCE_PATTERN.test(text) ||
    QUESTION_OR_RECOMMENDATION_PATTERN.test(text) ||
    (isQuestionAssertion(text) && NAMED_SOURCE_SIDE_SERVICE_ASSERTION_PATTERN.test(text)) ||
    ADS_ATTRIBUTED_COMMERCIAL_FRAME_PATTERN.test(text) ||
    PROTECTED_PRIVATE_LISTING_PATTERNS.some(({ pattern }) => testPattern(pattern, text))
  );
}

function findOfferInUnprotectedWindow(
  assertions: readonly LocalAssertion[],
  predicate: (window: LocalAssertion) => boolean,
): LocalAssertion | null {
  for (let index = 0; index < assertions.length; index += 1) {
    const first = assertions[index];
    if (first.protectedFrame) {
      continue;
    }

    let matchedWindow: LocalAssertion | null = null;
    let text = '';
    let normalizedText = '';
    for (
      let end = index;
      end < assertions.length && end < index + MAX_LOCAL_WINDOW_ASSERTIONS;
      end += 1
    ) {
      const assertion = assertions[end];
      if (assertion.protectedFrame) {
        break;
      }
      text = text ? `${text}. ${assertion.text}` : assertion.text;
      normalizedText = normalizedText
        ? `${normalizedText}. ${assertion.normalizedText}`
        : assertion.normalizedText;
      if (text.length > MAX_LOCAL_WINDOW_LENGTH) {
        break;
      }
      const window = {
        text,
        normalizedText,
        protectedFrame: false,
        parts: assertions.slice(index, end + 1),
      };
      if (predicate(window)) {
        matchedWindow = window;
      }
    }
    if (matchedWindow) {
      return matchedWindow;
    }
  }

  return null;
}

function hasEscalationOffer(
  assertion: LocalAssertion,
  riskPatterns: readonly CommercialLabeledPattern[],
): boolean {
  if (!hasRiskPattern(assertion, riskPatterns)) {
    return false;
  }
  if (
    DEMAND_SIDE_ESCALATION_FRAME_PATTERN.test(assertion.text) &&
    (BUYER_ESCALATION_EVIDENCE_PATTERN.test(assertion.text) ||
      BUYER_SERVICE_RESPONSE_PATTERN.test(assertion.text))
  ) {
    return false;
  }
  if ((assertion.parts?.length ?? 1) === 1) {
    return hasAffirmativeDealCue(assertion);
  }

  return (
    hasNonNegatedAffirmativeAction(assertion.text) ||
    AFFIRMATIVE_RESPONSE_CHANNEL_PATTERN.test(assertion.text) ||
    CROSS_ASSERTION_DEAL_PATTERN.test(assertion.text) ||
    ADS_CONTEXTUAL_PHONE_PLACEHOLDER_PATTERN.test(assertion.text) ||
    ADS_HANDLE_CONTACT_PATTERN.test(assertion.text) ||
    ADS_LINK_PATTERN.test(assertion.text) ||
    hasCommercialPhoneLikeText(assertion.text)
  );
}

function hasGeneralCommercialOffer(assertion: LocalAssertion): boolean {
  if (!hasAffirmativeDealCue(assertion) || EDITORIAL_CONTACT_PATTERN.test(assertion.text)) {
    return false;
  }
  return (
    (STRUCTURED_SERVICE_CARD_PATTERN.test(assertion.text) &&
      SOURCE_SIDE_SERVICE_NUMERIC_PRICE_PATTERN.test(assertion.text) &&
      hasUnattributedServiceResponse(assertion.text, true)) ||
    GENERAL_COMMERCIAL_PATTERNS.some(
      ({ pattern }) =>
        testPattern(pattern, assertion.text) || testPattern(pattern, assertion.normalizedText),
    ) ||
    hasPaidCommercialPlacementOffer(assertion.text) ||
    ADS_EXPLICIT_SOURCE_SIDE_PROMO_FRAME_PATTERN.test(assertion.text) ||
    EXPLICIT_FUEL_SELLER_OFFER_PATTERN.test(assertion.text) ||
    (FIRST_PERSON_SOURCE_SIDE_SERVICE_ASSERTION_PATTERN.test(assertion.text) &&
      SOURCE_SIDE_SERVICE_NUMERIC_PRICE_PATTERN.test(assertion.text) &&
      hasUnattributedServiceResponse(assertion.text, true)) ||
    (CURRENT_OFFER_RESPONSE_PATTERN.test(assertion.text) &&
      ADS_SERVICE_SPECIALTY_MARKERS.some((marker) => assertion.normalizedText.includes(marker)))
  );
}

function hasAffirmativeDealCue(assertion: LocalAssertion): boolean {
  if (hasNonNegatedAffirmativeAction(assertion.text)) {
    return true;
  }
  if (AFFIRMATIVE_TRANSACTION_PATTERN.test(assertion.text)) {
    return true;
  }
  if (AFFIRMATIVE_RESPONSE_CHANNEL_PATTERN.test(assertion.text)) {
    return true;
  }
  return (
    [
      ADS_CONTEXTUAL_PHONE_PLACEHOLDER_PATTERN,
      ADS_HANDLE_CONTACT_PATTERN,
      ADS_LINK_PATTERN,
      ADS_PRICE_PATTERN,
    ].some(
      (pattern) =>
        testPattern(pattern, assertion.text) || testPattern(pattern, assertion.normalizedText),
    ) || hasCommercialPhoneLikeText(assertion.text)
  );
}

function hasNonNegatedAffirmativeAction(text: string): boolean {
  AFFIRMATIVE_ACTION_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(AFFIRMATIVE_ACTION_PATTERN)) {
    const actionIndex = match.index + match[0].search(/[\p{L}\p{N}]/u);
    const prefix = text.slice(Math.max(0, actionIndex - 24), actionIndex);
    if (!NEGATION_BEFORE_ACTION_PATTERN.test(prefix)) {
      return true;
    }
  }
  return false;
}

function hasRiskPattern(
  assertion: Pick<LocalAssertion, 'text' | 'normalizedText'>,
  riskPatterns: readonly CommercialLabeledPattern[],
): boolean {
  return riskPatterns.some(
    ({ pattern }) =>
      testPattern(pattern, assertion.text) || testPattern(pattern, assertion.normalizedText),
  );
}

function selectRiskPatterns(labels: readonly string[]): CommercialLabeledPattern[] {
  const selectedLabels = new Set(labels);
  return [...ADS_HIGH_RISK_COMMERCIAL_PATTERNS, ...ADS_HIGH_RISK_RAW_LINK_PATTERNS].filter(
    ({ label }) => selectedLabels.has(label),
  );
}

function testPattern(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

function hasNonNegatedSourceSideServiceFrame(text: string, pattern: RegExp): boolean {
  pattern.lastIndex = 0;
  const match = pattern.exec(text);
  return match !== null && !NEGATED_SOURCE_SIDE_SERVICE_ASSERTION_PATTERN.test(match[0]);
}

function isQuestionAssertion(text: string): boolean {
  return /[?？]["'»”’“]?\s*$/u.test(text);
}

function insertNoSpaceDotAssertionBoundaries(text: string): string {
  return text.replace(/\./gu, (dot, offset: number, source: string) => {
    const previousCharacter = source[offset - 1] ?? '';
    const nextCharacter = source[offset + 1] ?? '';
    if (
      !nextCharacter ||
      /\s/u.test(nextCharacter) ||
      !NO_SPACE_DOT_LEFT_BOUNDARY_PATTERN.test(previousCharacter) ||
      !CYRILLIC_CHARACTER_PATTERN.test(nextCharacter)
    ) {
      return dot;
    }

    const suffix = source
      .slice(offset + 1)
      .match(/^\p{Script=Cyrillic}+/u)?.[0]
      .toLowerCase();
    if (suffix && CYRILLIC_DOMAIN_SUFFIXES.has(suffix)) {
      return dot;
    }
    return `${dot}\n`;
  });
}

type ProtectedQuoteDelimiter = 'ANGLE' | 'CURLY_HIGH' | 'CURLY_LOW' | 'STRAIGHT';

function scanProtectedQuoteDelimiters(
  text: string,
  initialDelimiters: readonly ProtectedQuoteDelimiter[] = [],
): ProtectedQuoteDelimiter[] {
  const delimiters = [...initialDelimiters];
  for (const character of text) {
    if (character === '«') {
      delimiters.push('ANGLE');
    } else if (character === '»' && delimiters.at(-1) === 'ANGLE') {
      delimiters.pop();
    } else if (character === '„') {
      delimiters.push('CURLY_LOW');
    } else if (character === '“') {
      if (delimiters.at(-1) === 'CURLY_LOW') {
        delimiters.pop();
      } else {
        delimiters.push('CURLY_HIGH');
      }
    } else if (character === '”' && delimiters.at(-1) === 'CURLY_HIGH') {
      delimiters.pop();
    } else if (character === '"') {
      if (delimiters.at(-1) === 'STRAIGHT') {
        delimiters.pop();
      } else {
        delimiters.push('STRAIGHT');
      }
    }
  }
  return delimiters;
}
