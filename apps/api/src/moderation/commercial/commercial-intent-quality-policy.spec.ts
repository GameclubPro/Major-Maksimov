import type { ChatSettings } from '../../prisma/prisma-client';
import { createRuleDetectionContext } from '../rule-engine-detection-context';
import { sanitizeCommercialCorpusText } from '../../scripts/commercial-corpus-sanitization.util';
import { CommercialAdDetector, COMMERCIAL_RELEASE_POLICY_COHORTS } from './commercial-ad.detector';
import { isCommercialMessageDeleteEligible } from './commercial-action-policy';
import { COMMERCIAL_PATTERN_RULES } from './commercial-patterns';
import type { CommercialPatternRule } from './commercial.types';
import {
  COMMERCIAL_INTENT_QUALITY_COHORT,
  COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
  resolveCommercialIntentQualityContext,
} from './commercial-intent-quality-policy';

const PROFILES = [
  {
    commercialAdsSensitivity: 'BALANCED',
    commercialAdsWarnThreshold: 45,
    commercialAdsDeleteThreshold: 65,
  },
  {
    commercialAdsSensitivity: 'STRICT',
    commercialAdsWarnThreshold: 38,
    commercialAdsDeleteThreshold: 55,
  },
] as const;
const settingsFor = (profile: (typeof PROFILES)[number]) =>
  ({ commercialAdsFilterEnabled: true, ...profile }) as ChatSettings;
const inputFor = (text: string, profile: (typeof PROFILES)[number]) => {
  const settings = settingsFor(profile);
  return { ...createRuleDetectionContext({ text, settings }), settings };
};
function cleanup(detection: ReturnType<CommercialAdDetector['detect']>): boolean {
  return (
    !!detection &&
    isCommercialMessageDeleteEligible(
      detection.actionBand ?? null,
      detection.actionable === true,
      detection.messageDisposition,
    )
  );
}

const PROTECTED = [
  'Хотела бы заказать уборку квартиры. Бюджет 3000 рублей. Мой телефон 8 900 000 10 42.',
  'Мы хотели заказать ремонт холодильника за 3000 рублей. Пишите мне 8 900 000 10 42.',
  'Кому можно заказать уборку квартиры? Бюджет 3000 рублей. Мой телефон 8 900 000 10 42.',
  'Услуги сантехника не оказываются. Старый прайс 3000 рублей. Телефон 8 900 000 10 42.',
  'Ремонт холодильников не выполняется. Телефон 8 900 000 10 42.',
  'Продаю свой холодильник за 10000 рублей. Возможна доставка, пишите 8 900 000 10 42.',
  'Продаю один диван за 10000 рублей. Привезу покупателю бесплатно. Телефон 8 900 000 10 42.',
  'Приглашаю в бесплатное сообщество любителей вязания. Общение и советы https://max.ru/join/sample.',
  'Приглашаю в наш канал любителей прогулок. Без рекламы и продаж https://max.ru/join/sample.',
  'Приглашаю в бесплатный чат поддержки по похудению. Общение, опыт и советы https://max.ru/join/sample.',
  'Приглашаю в сообщество: обсуждаем диагностику и лечение. Никаких платных услуг, только опыт https://max.ru/join/sample.',
  'Приглашаю в наш чат. Обсуждаем рекламу в городе, здесь только общение https://max.ru/join/sample.',
];
const OWNED_OFFERS = [
  'Я оказываю услуги уборки квартиры. Цена 3000 рублей. Звоните 8 900 000 10 42.',
  'Продаём холодильники в нашем магазине. Каталог, ассортимент, доставка. Звоните 8 900 000 10 42.',
  'Оказываю услуги доставки мебели. Цена от 3000 рублей. Звоните 8 900 000 10 42.',
  'Приглашаю в канал нашего магазина. Каталог, скидки и приём заказов https://max.ru/join/sample.',
  'Принимаю заказы на пряники. Пишите 8 900 000 10 42.',
  'Изготавливаю игрушки на заказ. Пишите мне 8 900 000 10 42.',
  // Observed sanitized corpus wording; its old automated label is not human quality evidence.
  'Хотите заказать эксклюзивный талисман или приобрести из наличия или заказать игрушку для свое малыша, прошу не стесняйтесь и пишите мне в личные сообщения или по номеру телефона [phone] Ирина. Обсудим все детали и оформим заказ.',
];

describe('commercial intent quality experimental policy', () => {
  it.each(PROTECTED)(
    'keeps assertion-owned demand, refusal, private delivery and invitation: %s',
    (text) => {
      for (const profile of PROFILES) {
        const detector = new CommercialAdDetector();
        for (const candidate of [
          text,
          sanitizeCommercialCorpusText(text),
          `Добрый день, ${text}`,
        ]) {
          const input = inputFor(candidate, profile);
          expect(cleanup(detector.detectExperimental(input))).toBe(false);
          expect(cleanup(detector.detectExperimental(input))).toBe(false);
          expect(cleanup(new CommercialAdDetector().detectExperimental(input))).toBe(false);
        }
      }
    },
  );

  it.each(OWNED_OFFERS)('retains source-side counterpairs without published prices: %s', (text) => {
    for (const profile of PROFILES) {
      const detector = new CommercialAdDetector();
      for (const candidate of [text, sanitizeCommercialCorpusText(text)]) {
        const input = inputFor(candidate, profile);
        const result = detector.detectExperimental(input);
        expect(cleanup(result)).toBe(true);
        expect(result?.decisionVersion).toBe(COMMERCIAL_INTENT_QUALITY_DECISION_VERSION);
        expect(result?.requiredPolicyCohorts).toContain(COMMERCIAL_INTENT_QUALITY_COHORT);
        expect(detector.detectExperimental(input)).toEqual(result);
        expect(new CommercialAdDetector().detectExperimental(input)).toEqual(result);
      }
    }
  });

  it.each([
    'Хотела бы заказать уборку квартиры. Бюджет 3000 рублей. Отдельно: мы ремонтируем холодильники от 2000 рублей. Звоните 8 900 000 10 42.',
    'Услуги электрика не оказываются, но мы изготавливаем игрушки на заказ. Пишите 8 900 000 10 42.',
    'Продаю свой холодильник за 10000 рублей. Возможна доставка. Отдельно: оказываю услуги перевозки мебели от 3000 рублей. Звоните 8 900 000 10 42.',
    'Приглашаю в бесплатное сообщество любителей вязания. https://max.ru/join/sample. Отдельно: принимаю заказы на пряники. Пишите 8 900 000 10 42.',
    'Хотела бы заказать уборку квартиры. Бюджет 3000 рублей. Ремонт холодильников, цена 2000 рублей, звоните 8 900 000 10 42.',
    'Хотела бы заказать уборку квартиры. Бюджет 3000 рублей. Казино: получите бонус за регистрацию https://bonus.example.ru.',
  ])('isolates an independent author offer after a protected assertion: %s', (text) => {
    for (const profile of PROFILES) {
      const detector = new CommercialAdDetector();
      const input = inputFor(text, profile);
      const candidate = detector.detectExperimental(input);
      expect(cleanup(candidate)).toBe(true);
      expect(candidate?.analysisText).toBeDefined();
      expect(candidate?.analysisText).not.toMatch(
        /бюджет|свой холодильник|бесплатное сообщество/iu,
      );
      expect(detector.detectExperimental(input)).toEqual(candidate);
    }
  });

  it('does not turn a current-order phrase in a quotation, testimonial or historical story into candidate proof', () => {
    for (const text of [
      'Моя подруга изготавливает игрушки на заказ. Её телефон 8 900 000 10 42.',
      'Раньше изготавливал игрушки на заказ. Сейчас заказы не принимаются. 8 900 000 10 42.',
      '«Изготавливаю игрушки на заказ». Это чужое объявление, его телефон 8 900 000 10 42.',
      'Изготавливаю игрушки для своих детей, хочу показать друзьям. Телефон 8 900 000 10 42.',
      'Хотите заказать игрушку? Подскажите мне мастера, пожалуйста. Мой телефон 8 900 000 10 42.',
    ]) {
      expect(
        resolveCommercialIntentQualityContext(text.toLowerCase()).ownedOrderOfferTexts,
      ).toEqual([]);
      for (const profile of PROFILES) {
        const input = inputFor(text, profile);
        const result = new CommercialAdDetector().detectExperimental(input);
        expect(result?.matchedSignals ?? []).not.toContain('transaction:quality-current-order');
      }
    }
  });

  it('pins the released baseline and grants no new cleanup to unpromoted candidates', () => {
    for (const profile of PROFILES) {
      const detector = new CommercialAdDetector();
      const input = inputFor('Принимаю заказы на пряники. Пишите 8 900 000 10 42.', profile);
      const baseline = detector.detect(input);
      expect(
        detector.detect({ ...input, promotedPolicyCohorts: COMMERCIAL_RELEASE_POLICY_COHORTS }),
      ).toEqual(baseline);
      expect(detector.detectExperimental({ ...input, promotedPolicyCohorts: [] })).toMatchObject({
        actionBand: 'REVIEW_ONLY',
        messageDisposition: 'KEEP',
        actionable: false,
        recordable: false,
      });
      expect(cleanup(detector.detectExperimental(input))).toBe(true);
      expect(detector.detect(input)).toEqual(baseline);
    }
  });

  it('does not grant baseline cleanup to a newly appended structured rule, even next to released evidence', () => {
    const mutableRules = COMMERCIAL_PATTERN_RULES as CommercialPatternRule[];
    const rule: CommercialPatternRule = {
      id: 'new-unreviewed-source-offer',
      subtype: 'SERVICES',
      taxonomyClass: 'TRUE_AD',
      pattern: /оказываю услуги уборки/giu,
      weight: 100,
      evidence: 'DIRECT',
      fpRisk: 0,
      examples: [],
    };
    const input = inputFor(OWNED_OFFERS[0], PROFILES[0]);
    const detector = new CommercialAdDetector();
    expect(cleanup(detector.detect(input))).toBe(true);
    mutableRules.push(rule);
    try {
      const result = detector.detect(input);
      expect(result).toMatchObject({
        actionBand: 'REVIEW_ONLY',
        messageDisposition: 'KEEP',
        actionable: false,
      });
      expect(result?.patternEvidence).toContain(rule.id);
      expect(result?.suppressionReasons).toContain(`unreleased-pattern:${rule.id}`);
      expect(cleanup(detector.detect(input))).toBe(false);
      expect(cleanup(new CommercialAdDetector().detect(input))).toBe(false);
      expect(cleanup(detector.detectExperimental({ ...input, promotedPolicyCohorts: [] }))).toBe(
        false,
      );
    } finally {
      mutableRules.splice(mutableRules.indexOf(rule), 1);
    }
    expect(cleanup(new CommercialAdDetector().detect(input))).toBe(true);
  });

  it('cannot erase an uninspected independent offer or borrow campaign repetition as commercial purpose', () => {
    for (const profile of PROFILES) {
      const input = inputFor(PROTECTED[0] + ' '.repeat(8_000) + OWNED_OFFERS[0], profile);
      const candidate = new CommercialAdDetector().detectExperimental(input);
      expect(cleanup(candidate)).toBe(false);
      if (candidate) expect(candidate.actionBand).toBe('REVIEW_ONLY');
      const invitation = inputFor(PROTECTED[7], profile);
      expect(
        new CommercialAdDetector().detectExperimental({
          ...invitation,
          commercialCampaignContext: {
            senderDistinctChatCount: 100,
            sameTextDistinctChatCount: 100,
            repeatedPhoneDistinctChatCount: 100,
            repeatedLinkDistinctChatCount: 100,
          },
        }),
      ).toBeNull();
    }
  });

  describe('bounded assertion coverage', () => {
    const editorial = [
      'Исследование о рекламе приводит пример',
      '«Я продаю цемент по 500 руб., доставка, телефон [phone]»',
      'Это цитата, не предложение',
    ];
    const buyer = 'Хотела бы заказать уборку квартиры';
    const offer = 'Принимаю заказы на пряники, пишите [phone]';
    const source = (count: number, withEditorial: boolean): string => {
      const assertions = [buyer, ...(withEditorial ? editorial : [])];
      while (assertions.length < count - 1) assertions.push('Соседи обсуждают погоду');
      return [...assertions, offer].join('. ');
    };

    it.each([63, 64, 65, 66])(
      'uses the original scan coverage for %i assertions, including grouped editorial quotes',
      (count) => {
        for (const withEditorial of [false, true]) {
          const text = source(count, withEditorial);
          const quality = resolveCommercialIntentQualityContext(text.toLowerCase());
          expect(quality.fullyInspected).toBe(count <= 64);
          if (count <= 64) expect(quality.independentOfferTexts).not.toHaveLength(0);
        }
      },
    );

    it.each([65, 66])(
      'keeps an independent tail offer at assertion %i review-only after quote grouping',
      (count) => {
        const text = source(count, true);
        for (const profile of PROFILES) {
          const detector = new CommercialAdDetector();
          const input = inputFor(text, profile);
          const baseline = detector.detect(input);
          const candidate = detector.detectExperimental(input);
          expect(candidate).toMatchObject({
            actionBand: 'REVIEW_ONLY',
            messageDisposition: 'KEEP',
            actionable: false,
            recordable: false,
          });
          expect(candidate?.suppressionReasons).toContain('quality-context-incomplete');
          expect(detector.detect(input)).toEqual(baseline);
          expect(detector.detectExperimental(input)).toEqual(candidate);
          expect(new CommercialAdDetector().detectExperimental(input)).toEqual(candidate);
        }
      },
    );
  });
});
