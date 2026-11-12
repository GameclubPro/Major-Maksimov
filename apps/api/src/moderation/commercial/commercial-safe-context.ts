import {
  isCommercialEscalationRiskSignal,
  resolveCommercialSignalEvidence,
} from './commercial-evidence';
import {
  hasQualifiedSourceSideServiceOffer,
  hasExplicitServiceBookingCard,
  hasUnattributedServiceResponse,
  resolveStandaloneEditorialQuoteContext,
  splitCommercialAssertions,
} from './commercial-local-context';
import {
  ADS_EXPLICIT_SOURCE_SIDE_PROMO_FRAME_PATTERN,
  ADS_NAMED_ECOMMERCE_SOURCE_SIDE_FRAME_PATTERN,
  ADS_STOCK_PRICE_CONTACT_DELIVERY_SOURCE_SIDE_FRAME_PATTERN,
} from './commercial-patterns';

export type CommercialSafeContextBucket =
  | 'rules_or_moderation_context'
  | 'spam_complaint_or_fraud_warning'
  | 'news_or_analytics'
  | 'brand_mention_only'
  | 'private_one_off_sale'
  | 'ordinary_recruitment'
  | 'public_training_or_help'
  | 'request_or_recommendation'
  | 'none';

const RULES_OR_MODERATION_CONTEXT_PATTERNS = [
  /(?:^|[^\p{L}\p{N}_-])(?:реклам[\p{L}\p{N}_-]*|объявлен[\p{L}\p{N}_-]*|ссылк[\p{L}\p{N}_-]*|спам[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;!?'"«»()/%+-]{0,80})(?:запрещ[её]н[\p{L}\p{N}_-]*|нельзя|удал[яи][\p{L}\p{N}_-]*|бан[\p{L}\p{N}_-]*|мут[\p{L}\p{N}_-]*|модерац[\p{L}\p{N}_-]*|модератор[\p{L}\p{N}_-]*|админ[\p{L}\p{N}_-]*|фильтр[\p{L}\p{N}_-]*)/iu,
  /(?:^|[^\p{L}\p{N}_-])(?:запрещ[её]н[\p{L}\p{N}_-]*|нельзя|удал[яи][\p{L}\p{N}_-]*|бан[\p{L}\p{N}_-]*|мут[\p{L}\p{N}_-]*|модерац[\p{L}\p{N}_-]*|модератор[\p{L}\p{N}_-]*|админ[\p{L}\p{N}_-]*|фильтр[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;!?'"«»()/%+-]{0,80})(?:реклам[\p{L}\p{N}_-]*|объявлен[\p{L}\p{N}_-]*|ссылк[\p{L}\p{N}_-]*|спам[\p{L}\p{N}_-]*)/iu,
  /(?:^|[^\p{L}\p{N}_-])(?:пример|образец|цитат[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;!?'"«»()/%+-]{0,60})(?:реклам[\p{L}\p{N}_-]*|объявлен[\p{L}\p{N}_-]*|спам[\p{L}\p{N}_-]*)/iu,
  /(?:^|[^\p{L}\p{N}_-])(?:бот|фильтр[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;!?'"«»()/%+-]{0,60})(?:удал[яи][\p{L}\p{N}_-]*|бан[\p{L}\p{N}_-]*|мут[\p{L}\p{N}_-]*|блокир[\p{L}\p{N}_-]*|фильтру[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;!?'"«»()/%+-]{0,60})(?:реклам[\p{L}\p{N}_-]*|объявлен[\p{L}\p{N}_-]*|ссылк[\p{L}\p{N}_-]*|спам[\p{L}\p{N}_-]*)?/iu,
] as const;

const FRAUD_WARNING_CONTEXT_PATTERNS = [
  /(?:^|[^\p{L}\p{N}_-])(?:мошенник[\p{L}\p{N}_-]*|спамер[\p{L}\p{N}_-]*|это\s+спам|полици[\p{L}\p{N}_-]*\s+предупрежда[\p{L}\p{N}_-]*|мвд\s+предупрежда[\p{L}\p{N}_-]*|предупрежда(?:ет|ют|ем)|осторожн[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;!?"'«»()/%+-]{0,220})(?:не\s+(?:переходите|переводите|отправляйте|сообщайте|верьте|звоните|пишите)|обман[\p{L}\p{N}_-]*|похищ[\p{L}\p{N}_-]*|сообщите\s+(?:в\s+)?(?:полици[\p{L}\p{N}_-]*|мвд|админ[\p{L}\p{N}_-]*))(?=$|[^\p{L}\p{N}_-])/iu,
  /(?:^|[^\p{L}\p{N}_-])(?:не\s+(?:переходите|переводите|отправляйте|сообщайте|верьте|звоните|пишите)|обман[\p{L}\p{N}_-]*|похищ[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;!?"'«»()/%+-]{0,180})(?:мошенник[\p{L}\p{N}_-]*|спамер[\p{L}\p{N}_-]*|спам|полици[\p{L}\p{N}_-]*|мвд|предупрежда[\p{L}\p{N}_-]*|осторожн[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu,
] as const;

const NEWS_OR_ANALYTICS_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:новост(?:ь|и|ью|ей|ям|ями|ях|н[\p{L}\p{N}_-]*)|отчет|отч[её]т|аналитик[\p{L}\p{N}_-]*|статистик[\p{L}\p{N}_-]*|обзор|рынк[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu;

const PUBLIC_TRAINING_OR_HELP_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:администраци[\p{L}\p{N}_-]*|госуслуг[\p{L}\p{N}_-]*|компенсаци[\p{L}\p{N}_-]*|голосовани[\p{L}\p{N}_-]*|обучени[\p{L}\p{N}_-]*\s+бесплатн[\p{L}\p{N}_-]*|центр\s+занятост[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu;

const BRAND_MENTION_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:отзыв|жалоба|подскажите|посоветуйте|кто\s+знает)(?:[\p{L}\p{N}\s.,:;()/%+-]{0,100})(?:wildberries|wb|вб|ozon|озон|авито|банк|маркетплейс[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu;

const PROFESSIONAL_APPAREL_RETAIL_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:люкс\s+качеств[\p{L}\p{N}_-]*|фабричн[\p{L}\p{N}_-]*\s+качеств[\p{L}\p{N}_-]*|производств[\p{L}\p{N}_-]*\s+(?:турци[\p{L}\p{N}_-]*|иванов[\p{L}\p{N}_-]*)|купить\s+и\s+заказать|предоплат[\p{L}\p{N}_-]*|размерн[\p{L}\p{N}_-]*\s+ряд|нов[\p{L}\p{N}_-]*\s+поступлени[\p{L}\p{N}_-]*|в\s+наличи[ие]|ассортимент[\p{L}\p{N}_-]*|каталог[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu;

const NATIONWIDE_APPAREL_FULFILLMENT_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:доставк[\p{L}\p{N}\s.,:;()/%+-]{0,50}росси[\p{L}\p{N}_-]*|транспортн[\p{L}\p{N}\s.,:;()/%+-]{0,20}компан[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu;

const DIRECT_DEAL_SIGNAL_PREFIXES = ['contact:', 'deal-channel:', 'transaction:'] as const;

const COMMERCIAL_SELF_PROMO_SIGNAL_PREFIXES = [
  'business:',
  'buyout:',
  'channel-placement:',
  'goods-retail:',
  'group-promo:',
  'info:',
  'intent:',
  'property-agent:',
  'property-commercial:',
  'recruitment:',
  'service-specialty:',
] as const;

const EXPLICIT_SOURCE_SIDE_OFFER_SIGNAL_PREFIXES = [
  'buyout:',
  'channel-placement:',
  'goods-retail:',
  'info:',
  'promo:',
  'property-agent:',
  'property-commercial:',
  'recruitment:',
] as const;

const LOCAL_PRIVATE_LIKE_RETAIL_SIGNALS = new Set([
  'goods-retail:wholesale-produce',
  'goods-retail:collectible-flower-retail',
  'goods-retail:flower-herb-unit-price-retail',
  'goods-retail:plant-nursery-stock',
  'goods-retail:plant-nursery-clearance-stock',
  'goods-retail:farm-livestock-retail',
  'goods-retail:poultry-farm-order',
  'goods-retail:home-food-order',
  'goods-retail:home-dairy-retail',
]);

const AMBIGUOUS_SERVICE_INTENT_SIGNALS = new Set([
  'intent:услуга',
  'intent:услуги',
  'intent:выполняем-работы',
]);
const TRUSTED_SOURCE_SIDE_RETAIL_RECALL_SIGNALS = new Set([
  'goods-retail:first-person-custom-manufacturing',
  'goods-retail:furniture-stock-installment',
  'goods-retail:named-manufacturer-price-catalog',
  'goods-retail:passive-multi-sku-order-catalog',
]);
const POST_QUESTION_PAID_SERVICE_PRESENTATION_PATTERN =
  /^(?:(?:юридическ[а-яё-]*\s+)?услуг[а-яё-]*|сервис[а-яё-]*)(?=$|[^\p{L}\p{N}_-])/iu;
const POST_QUESTION_PAID_SERVICE_PRICE_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(?:(?:цен[аы]|стоимост[ьи])\s*(?:от\s*)?\d{2,}|\d[\d\s.,]{0,16}\s*(?:р(?:уб)?\.?|₽))(?=$|[^\p{L}\p{N}_-])/iu;
const QUESTION_ASSERTION_END_PATTERN = /[?？]+["'»”’“]?\s*$/u;

export function hasPostQuestionPaidServiceOffer(text: string): boolean {
  const assertions = splitCommercialAssertions(text.slice(0, 1_400).toLowerCase()).slice(0, 8);
  const offerIndex = assertions.findIndex(
    (assertion, index) =>
      index > 0 &&
      QUESTION_ASSERTION_END_PATTERN.test(assertions[index - 1]) &&
      POST_QUESTION_PAID_SERVICE_PRESENTATION_PATTERN.test(assertion),
  );
  if (offerIndex < 0) {
    return false;
  }
  const window = assertions
    .slice(offerIndex, offerIndex + 3)
    .join('. ')
    .slice(0, 700);
  return (
    POST_QUESTION_PAID_SERVICE_PRICE_PATTERN.test(window) && hasUnattributedServiceResponse(window)
  );
}

export function hasCommercialDirectDealSignal(signals: readonly string[]): boolean {
  return signals.some((signal) =>
    DIRECT_DEAL_SIGNAL_PREFIXES.some((prefix) => signal.startsWith(prefix)),
  );
}

function hasCommercialSelfPromoSignal(signals: readonly string[]): boolean {
  return signals.some((signal) =>
    COMMERCIAL_SELF_PROMO_SIGNAL_PREFIXES.some((prefix) => signal.startsWith(prefix)),
  );
}

function hasExplicitSourceSideOfferSignal(signals: readonly string[], text: string): boolean {
  const recallCompanionSignals = new Set(
    signals
      .filter((signal) => signal.startsWith('recall-source:'))
      .map((signal) => signal.slice('recall-source:'.length)),
  );
  const hasSourceSideRetailFrame =
    ADS_EXPLICIT_SOURCE_SIDE_PROMO_FRAME_PATTERN.test(text) ||
    ADS_NAMED_ECOMMERCE_SOURCE_SIDE_FRAME_PATTERN.test(text) ||
    ADS_STOCK_PRICE_CONTACT_DELIVERY_SOURCE_SIDE_FRAME_PATTERN.test(text);

  return signals.some((signal) => {
    const requiresSourceSideRetailFrame =
      signal.startsWith('promo:') || signal.startsWith('goods-retail:');
    const hasTrustedSourceSideRecall = TRUSTED_SOURCE_SIDE_RETAIL_RECALL_SIGNALS.has(signal);
    return (
      EXPLICIT_SOURCE_SIDE_OFFER_SIGNAL_PREFIXES.some((prefix) => signal.startsWith(prefix)) &&
      (!requiresSourceSideRetailFrame || hasSourceSideRetailFrame || hasTrustedSourceSideRecall) &&
      (!recallCompanionSignals.has(signal) || hasTrustedSourceSideRecall)
    );
  });
}

export function deriveCommercialSafeContextBucket(params: {
  text: string;
  matchedSignals?: readonly string[];
  negativeSignals?: readonly string[];
  hasCommercialHit?: boolean;
}): CommercialSafeContextBucket {
  const matchedSignals = params.matchedSignals ?? [];
  const negativeSignals = params.negativeSignals ?? [];
  const text = params.text.toLowerCase();
  const hasCommercialHit = params.hasCommercialHit === true;
  const hasDirectDealSignal = hasCommercialDirectDealSignal(matchedSignals);
  const hasSelfPromoSignal = hasCommercialSelfPromoSignal(matchedSignals);
  const signalEvidence = resolveCommercialSignalEvidence(matchedSignals);
  const hasEscalationRiskEvidence = signalEvidence.hasEscalationRiskEvidence;
  const standaloneEditorialQuoteContext = resolveStandaloneEditorialQuoteContext({
    rawLoweredText: text,
    escalationRiskLabels: matchedSignals
      .filter(isCommercialEscalationRiskSignal)
      .map((signal) => signal.slice('risk:'.length)),
    includeOrdinaryProtectedContext: true,
  });
  const hasPriceSignal = matchedSignals.some(
    (signal) => signal === 'transaction:price' || signal === 'transaction:implied-price',
  );
  const hasProfessionalLocalRetailOrder =
    signalEvidence.hasActionDirectDealEvidence &&
    matchedSignals.includes('goods-retail:professional-order-catalog');
  const hasProfessionalServiceOffer =
    hasDirectDealSignal &&
    matchedSignals.some(
      (signal) =>
        signal === 'transaction:structured-service-offer' ||
        signal.startsWith('recall-source:service-specialty:') ||
        signal === 'service-specialty:internet-connection-service' ||
        signal === 'service-specialty:divination-self-offer' ||
        signal === 'risk:divination-contact-offer',
    ) &&
    matchedSignals.some(
      (signal) =>
        signal.startsWith('business:') ||
        signal.startsWith('intent:') ||
        signal.startsWith('recall-source:service-specialty:') ||
        signal === 'service-specialty:divination-self-offer' ||
        signal === 'risk:divination-contact-offer',
    );
  const hasExplicitPaidServiceIntent =
    matchedSignals.some(
      (signal) => signal.startsWith('intent:') && !AMBIGUOUS_SERVICE_INTENT_SIGNALS.has(signal),
    ) ||
    (matchedSignals.includes('intent:выполняем-работы') &&
      /(?:^|[^\p{L}\p{N}_-])(?:выполня(?:ем|ю)|оказыва(?:ем|ю)|предлага(?:ем|ю))(?=$|[^\p{L}\p{N}_-])/iu.test(
        text,
      )) ||
    (matchedSignals.some((signal) => signal === 'intent:услуга' || signal === 'intent:услуги') &&
      hasPostQuestionPaidServiceOffer(text));
  const hasExplicitPaidServiceOffer =
    hasPriceSignal &&
    hasDirectDealSignal &&
    (matchedSignals.some((signal) => signal.startsWith('business:')) ||
      hasExplicitPaidServiceIntent) &&
    matchedSignals.some((signal) => signal.startsWith('service-specialty:'));
  const hasExplicitPrivateSaleSignal = negativeSignals.some(
    (signal) =>
      signal.startsWith('private:') ||
      signal.startsWith('private-single:') ||
      signal.startsWith('private-goods:'),
  );
  const hasStrongExplicitPrivateSaleSignal = negativeSignals.some(
    (signal) =>
      signal.startsWith('private:') ||
      signal.startsWith('private-single:') ||
      (signal.startsWith('private-goods:') &&
        signal !== 'private-goods:apparel-size' &&
        signal !== 'private-goods:measurements'),
  );
  const hasProfessionalApparelRetailOverride =
    !hasStrongExplicitPrivateSaleSignal &&
    matchedSignals.includes('goods-retail:apparel-retail-order-flow') &&
    PROFESSIONAL_APPAREL_RETAIL_PATTERN.test(text) &&
    NATIONWIDE_APPAREL_FULFILLMENT_PATTERN.test(text);
  const hasProfessionalPrivateSaleOverride =
    hasProfessionalLocalRetailOrder ||
    hasProfessionalServiceOffer ||
    (hasDirectDealSignal &&
      (hasQualifiedSourceSideServiceOffer(text) || hasExplicitServiceBookingCard(text))) ||
    hasProfessionalApparelRetailOverride ||
    (!hasExplicitPrivateSaleSignal &&
      matchedSignals.includes('goods-retail:bulk-crop-dispatch-offer')) ||
    (!hasExplicitPrivateSaleSignal &&
      matchedSignals.includes('goods-retail:professional-retail-structure')) ||
    (hasDirectDealSignal &&
      matchedSignals.some(
        (signal) =>
          signal.startsWith('buyout:') ||
          (signal.startsWith('property-agent:') &&
            signal !== 'property-agent:structured-rental-review') ||
          signal.startsWith('property-commercial:') ||
          signal.startsWith('channel-placement:') ||
          signal.startsWith('group-promo:'),
      ));
  const hasLocalPrivateLikeRetailSignal = matchedSignals.some((signal) =>
    LOCAL_PRIVATE_LIKE_RETAIL_SIGNALS.has(signal),
  );
  const hasLinkOrRiskSignal = matchedSignals.some(
    (signal) => signal.startsWith('deal-channel:') || signal.startsWith('risk:'),
  );
  const hasEscalationOffer =
    hasEscalationRiskEvidence && signalEvidence.hasLocalEscalationOfferEvidence;
  const hasStructuredRecruitmentOffer = matchedSignals.some((signal) =>
    signal.startsWith('recall-source:recruitment:'),
  );
  const hasExplicitSourceSideOffer =
    (hasDirectDealSignal && hasExplicitSourceSideOfferSignal(matchedSignals, text)) ||
    hasQualifiedSourceSideServiceOffer(text);
  const hasEmbeddedCurrentServiceOffer =
    matchedSignals.includes('intent:current-service-booking-offer') &&
    matchedSignals.some((signal) => signal.startsWith('service-specialty:')) &&
    /(?:^|[^\p{L}\p{N}_-])можно\s+заказать\s+у\s+админ[а-яё-]*(?:[\s\S]{0,100})(?:фото|видео)[\p{L}\p{N}_-]*\s+монтаж(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    );
  const hasSignal = (signal: string): boolean => negativeSignals.includes(signal);
  const hasSignalPrefix = (prefix: string): boolean =>
    negativeSignals.some((signal) => signal.startsWith(prefix));

  if (
    (hasSignal('context:moderation-ad-discussion') && !hasEmbeddedCurrentServiceOffer) ||
    hasSignal('context:quoted-ad-example') ||
    hasSignal('context:attributed-commercial-report') ||
    (standaloneEditorialQuoteContext !== null &&
      !standaloneEditorialQuoteContext.hasIndependentCommercialOffer &&
      !standaloneEditorialQuoteContext.hasIndependentEscalationOffer)
  ) {
    return 'rules_or_moderation_context';
  }

  if (hasSignal('context:reported-escalation-risk') && !hasEscalationOffer) {
    return 'spam_complaint_or_fraud_warning';
  }

  if (
    !hasCommercialHit &&
    RULES_OR_MODERATION_CONTEXT_PATTERNS.some((pattern) => pattern.test(text))
  ) {
    return 'rules_or_moderation_context';
  }

  if (
    !hasEscalationOffer &&
    (hasSignal('context:public-fraud-warning') ||
      FRAUD_WARNING_CONTEXT_PATTERNS.some((pattern) => pattern.test(text)))
  ) {
    return 'spam_complaint_or_fraud_warning';
  }

  if (
    hasSignal('context:local-news-subscribe') ||
    hasSignal('context:channel-metrics-not-selling') ||
    hasSignal('context:giveaway-results-report') ||
    hasSignal('context:fuel-price-analysis') ||
    (hasSignal('context:fuel-availability-report') &&
      !(hasPriceSignal && hasDirectDealSignal && hasSelfPromoSignal)) ||
    (NEWS_OR_ANALYTICS_PATTERN.test(text) && (!hasCommercialHit || !hasDirectDealSignal))
  ) {
    return 'news_or_analytics';
  }

  if (
    hasSignal('context:official-civic-instruction') ||
    hasSignal('context:public-voting-contest') ||
    hasSignal('context:public-service-enrollment') ||
    (hasSignal('context:public-training-or-event') && !hasEscalationRiskEvidence) ||
    (hasSignal('context:public-help-request') && !hasEscalationRiskEvidence) ||
    (!hasEscalationRiskEvidence &&
      PUBLIC_TRAINING_OR_HELP_PATTERN.test(text) &&
      (!hasCommercialHit || !hasDirectDealSignal || !hasSelfPromoSignal))
  ) {
    return 'public_training_or_help';
  }

  if (
    hasSignalPrefix('job-seeking:') &&
    !hasEscalationOffer &&
    !hasProfessionalServiceOffer &&
    !hasStructuredRecruitmentOffer
  ) {
    return 'ordinary_recruitment';
  }

  if (
    !hasEscalationOffer &&
    !hasProfessionalServiceOffer &&
    !hasExplicitPaidServiceOffer &&
    !hasExplicitSourceSideOffer &&
    (hasSignalPrefix('search:') || hasSignalPrefix('search-pattern:'))
  ) {
    return 'request_or_recommendation';
  }

  if (hasSignal('context:animal-adoption') && !hasPriceSignal) {
    return 'request_or_recommendation';
  }

  if (
    !hasEscalationRiskEvidence &&
    !hasProfessionalPrivateSaleOverride &&
    (hasSignalPrefix('private:') ||
      hasSignalPrefix('private-single:') ||
      hasSignalPrefix('private-goods:') ||
      (hasLocalPrivateLikeRetailSignal && !hasLinkOrRiskSignal))
  ) {
    return 'private_one_off_sale';
  }

  if (
    !hasEscalationOffer &&
    BRAND_MENTION_PATTERN.test(text) &&
    (!hasCommercialHit || !hasSelfPromoSignal)
  ) {
    return 'brand_mention_only';
  }

  return 'none';
}
