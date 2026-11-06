import { RuleEngineService } from '../rule-engine.service';

const BASE_SETTINGS = {
  russianProfanityFilterEnabled: true,
  commercialAdsFilterEnabled: false,
  messageLimitsBlockedWords: [],
  messageLimitsBlockedDomains: [],
  phoneNumbersEnabled: true,
  photoMessagesEnabled: true,
  videoMessagesEnabled: true,
  fileMessagesEnabled: true,
  voiceMessagesEnabled: true,
};

describe('structured profanity rule-engine decision', () => {
  const previousRolloutMode = process.env.PROFANITY_V2_ROLLOUT_MODE;

  beforeEach(() => {
    delete process.env.PROFANITY_V2_ROLLOUT_MODE;
  });

  afterAll(() => {
    if (previousRolloutMode === undefined) {
      delete process.env.PROFANITY_V2_ROLLOUT_MODE;
    } else {
      process.env.PROFANITY_V2_ROLLOUT_MODE = previousRolloutMode;
    }
  });

  describe.each(['on', 'legacy'] as const)('numeric lists in %s rollout', (rolloutMode) => {
    beforeEach(() => {
      process.env.PROFANITY_V2_ROLLOUT_MODE = rolloutMode;
    });

    it.each(['CORE_ONLY', 'BALANCED', 'STRICT'] as const)(
      'allows numeric listings without hiding abuse at %s sensitivity',
      async (profanitySensitivity) => {
        const service = new RuleEngineService({} as never);
        const safeTexts = [
          'Новая обувь. ОТДАМ ПО ЦЕНЕ ЗАКУПА. МНОГО 32.33.36.37......ОТ 1000',
          'Размеры 32, 33, 36, 37 от 1000 руб.',
          '36.37.ОТ 1000',
          '36 37 от 1000',
          'Цены 36, 37, 38 руб.',
          'Ты носишь 36/37 размер?',
        ];
        const abusiveTexts = [
          'Новая обувь 32.33.36.37 от 1000, блять',
          '36.37.блять',
          'блять.36.37',
          '36.37.6лять',
          '36.37.36л',
          '36.37.е..бать',
          '36.37.б л я т ь',
          '36.37.p1zda',
          'p1zda.36.37',
          'Размеры 36, 37, а ты 36л',
          '3 6 а т ь',
          '36 а т ь',
          '36/37ать',
        ];

        for (const text of [...safeTexts, ...abusiveTexts]) {
          const result = await service.detect({
            chatId: 'chat-1',
            userId: 'user-1',
            text,
            settings: { ...BASE_SETTINGS, profanitySensitivity } as never,
            domainAllowlist: [],
          });

          expect({
            text,
            hasProfanity: result.violations.some(({ ruleCode }) => ruleCode === 'PROFANITY'),
          }).toEqual({ text, hasProfanity: abusiveTexts.includes(text) });
        }
      },
    );
  });

  it('uses BALANCED when generated settings do not contain sensitivity yet', async () => {
    const service = new RuleEngineService({} as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'ты скотина',
      settings: BASE_SETTINGS as never,
      domainAllowlist: [],
    });

    expect(result.violations).toEqual([]);
  });

  it.each(['on', 'legacy'] as const)(
    'uses the same side-effect-free decision for dispatch and ingestion in %s rollout',
    async (rolloutMode) => {
      process.env.PROFANITY_V2_ROLLOUT_MODE = rolloutMode;
      const service = new RuleEngineService({} as never);
      for (const profanitySensitivity of ['CORE_ONLY', 'BALANCED', 'STRICT'] as const) {
        for (const text of [
          'Бак 36л',
          'ты скотина',
          'ты мудак',
          'блять',
          'Группа 3-6 л. для детей',
          'хуууй',
          'привет,блять',
          'съебал',
          'blyaha na remne',
          'Питомник продаёт щенков. Ты сука!',
          'ты д у р а к',
        ]) {
          const settings = { ...BASE_SETTINGS, profanitySensitivity } as never;
          const pure = service.detectProfanityForSettings(text, settings);
          const result = await service.detect({
            chatId: 'chat-1',
            userId: 'user-1',
            text,
            settings,
            domainAllowlist: [],
          });
          const violation = result.violations.find((item) => item.ruleCode === 'PROFANITY');
          if (pure) {
            const { score, ...metadata } = pure;
            expect(violation).toEqual(expect.objectContaining({ score, metadata }));
          } else {
            expect(violation).toBeUndefined();
          }
        }
      }
      expect(
        service.detectProfanityForSettings('блять', {
          russianProfanityFilterEnabled: false,
          profanitySensitivity: 'STRICT',
        }),
      ).toBeNull();
    },
  );

  it('keeps explicitly configured stop words independent of automatic profanity exceptions', async () => {
    const service = new RuleEngineService({} as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'EBITDA',
      domainAllowlist: [],
      settings: { ...BASE_SETTINGS, messageLimitsBlockedWords: ['EBITDA'] } as never,
    });
    expect(result.violations.map((item) => item.ruleCode)).toEqual(['MESSAGE_BLOCKED_WORD']);
  });

  it.each(['привет,блять', '3-6лет,блять', 'блять,3-6лет', 'EBITDA,блять', 'блять,EBITDA'])(
    'retains independent word evidence beside punctuation in %s',
    (text) => {
      const service = new RuleEngineService({} as never);
      expect(service.detectProfanityForSettings(text, BASE_SETTINGS as never)).toMatchObject({
        category: 'CORE_MAT',
        familyId: 'core:blyad',
        matchedVariant: 'блять',
      });
    },
  );

  it('records repetition evidence only when repeated letters were folded', () => {
    const service = new RuleEngineService({} as never);
    expect(service.detectProfanityForSettings('хуууй', BASE_SETTINGS as never)).toMatchObject({
      matchedVariant: 'хуй',
      evidence: ['REPEATED_LETTERS'],
      detectorVersion: 'profanity-structured-v4',
    });
    expect(
      service.detectProfanityForSettings('ебанный', BASE_SETTINGS as never)?.evidence,
    ).not.toContain('REPEATED_LETTERS');
  });

  it('does not rescan the whole message for words outside contextual exception families', () => {
    const service = new RuleEngineService({} as never);
    const probe = service as unknown as {
      hasUnsafeProfanityContextAroundToken(token: string, context: string): boolean;
    };
    const contextScan = jest.spyOn(probe, 'hasUnsafeProfanityContextAroundToken');
    expect(
      service.detectProfanityForSettings('Обычный текст. '.repeat(100), {
        russianProfanityFilterEnabled: true,
        profanitySensitivity: 'BALANCED',
      }),
    ).toBeNull();
    expect(contextScan).not.toHaveBeenCalled();
  });

  it('emits category score and explainable metadata for a STRICT mild hit', async () => {
    const service = new RuleEngineService({} as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'ты скотина',
      settings: { ...BASE_SETTINGS, profanitySensitivity: 'STRICT' } as never,
      domainAllowlist: [],
    });

    expect(result.violations).toEqual([
      {
        ruleCode: 'PROFANITY',
        score: 0.75,
        reason: 'Detected profanity or abusive language pattern',
        metadata: {
          category: 'MILD_INSULT',
          sensitivity: 'STRICT',
          rolloutMode: 'on',
          familyId: 'exact:скотин',
          matchKind: 'EXACT_VARIANT',
          matchedVariant: 'скотина',
          evidence: ['TARGET_CONTEXT'],
          detectorVersion: 'profanity-structured-v4',
        },
      },
    ]);
  });

  it('lets legacy rollout override stored sensitivity without enabling v2-only terms', async () => {
    process.env.PROFANITY_V2_ROLLOUT_MODE = 'legacy';
    const service = new RuleEngineService({} as never);
    const legacyHit = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'ты скотина',
      settings: { ...BASE_SETTINGS, profanitySensitivity: 'CORE_ONLY' } as never,
      domainAllowlist: [],
    });
    const v2OnlyTerm = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'ты валенок',
      settings: { ...BASE_SETTINGS, profanitySensitivity: 'STRICT' } as never,
      domainAllowlist: [],
    });

    expect(legacyHit.violations[0]).toEqual(
      expect.objectContaining({
        score: 0.95,
        metadata: expect.objectContaining({
          category: 'MILD_INSULT',
          sensitivity: 'STRICT',
          rolloutMode: 'legacy',
        }),
      }),
    );
    expect(v2OnlyTerm.violations).toEqual([]);
  });
});
