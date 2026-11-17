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

const SAFE_NORMALIZATION_CASES = [
  'Отдам (3-6 л) за сладость, Новотроицк.',
  'Горшки 3-6л, отдам за сладость) Новотроицк.',
  'Горшок 36 л для цветов',
  'Кашпо 3–6 л для растений',
  'Отдам 3-6л за сладость',
  'ОТДАЮ (3 — 6 л), самовывоз',
  'Продам (3,6–6,5 л), самовывоз',
  'Продаются 36л за 500 рублей',
  'Меняю (36 л) на сладость',
  'Открыт набор в арт-студию «Матрёшка»! Приглашаем детей на творческие занятия в тёплой, поддерживающей атмосфере, без оценок, в радость и в темпе ребёнка. ЧЕТВЕРГ: 16:00 - группа 3-6 л.',
  'Группа для детей 3-6лет',
  'ЧЕТВЕРГ: 16:00 - гр. 3-6 л.',
  'ЧЕТВЕРГ: 16:00 - гр.3-6л.',
  'ЧЕТВЕРГ: 16:00 - гр.3-6 л.',
  'Возрастная гр. 3-6 л. в арт-студии',
  '3-6 л., группа рисования',
  '3-6л,дети рисуют',
  'Приглашаем детей 3–6 л.',
  'Занятия для детей 3 — 6 л.',
  'Рисование: группа 3-6л.',
  'Развивающие занятия для детей 3-6-летнего возраста',
  'Вы записали ребенка в группу 3-6 л.?',
  'Объем бака 3-6л воды',
  'Вам нужна канистра на 3–6 л?',
  'Емкость 3,6–6,5 л',
  '3-6 литров',
  '3-6 лет',
  'Бляяха на ремне',
  'Подстрахуууй меня',
  'Алла, Анна и Кирилл идут в бассейн',
  'EBITDA,прибыль и выручка',
  'Лампы Hue,параметры цвета',
  'Дети 3-6 л.,занятия по четвергам',
  'EBIT составил 500 млн рублей',
  'EBITDA выросла на 20%',
  'В отчете указан показатель ebitda.',
  'Ты сравнил EBIT и EBITDA за квартал?',
  'Use hue to adjust color',
  'Лампы Philips Hue доступны в магазине',
  'Тебе нравится цвет Philips Hue?',
  'Проверьте параметр hue в редакторе',
  'Christiaan Huygens discovered Titan',
  'Напишите на hue@example.com',
  'Отчет отправлен на ebitda@company.ru',
  'Копия для huygens@example.org',
  'Открой ebitda.csv',
  'Счет ebitda-2026.xlsx',
  'Сучки на доске можно зашлифовать',
  'Доска сухая, небольшие сучки на поверхности',
  'Брак в древесине: сучки',
  'Бак на 36л воды',
  'Объем 36 л',
  'Топливо 36л',
  'Продается рюкзак на 36л',
  'Тебе нужен бак объемом 36л?',
  'Объем 36л, а вы какую модель выбрали?',
  'Бак на 36 л, но ты можешь взять меньший.',
  'Канистра 36л и 2л воды.',
  'Мне 36 лет, работаю инженером.',
  'Возраст: 36лет.',
  'Тебе 36 лет?',
  '36л',
  '36 л',
  '36-летний инженер.',
  'Бак 36 литров.',
  'Мотор на 36 л.с., бензин.',
  'Пидоров Павел выступил на конференции',
  '  Пидоров Павел выступил на конференции',
  '\n\tПидоров Павел выступил на конференции',
  'https://example.com Пидоров Павел выступил на конференции',
  'Ссылка https://example.com: Пидоров Павел выступил на конференции',
  'https://example.com Мудаков Михаил ведет трансляцию',
  'https://example.com Михаил Мудаков ведет трансляцию',
  'https://example.com Сукин Борис выступил',
] as const;

const CORE_MAT_CONTROLS = [
  'Отдам (3-6 л) за сладость, блять',
  'Горшки 3-6л,блять',
  'блять,Отдам (3-6 л) за сладость',
  'Горшки 3-6л, а ты 36л',
  'Отдам (3-6 л). Ты 3-6 л',
  'Отдам 3-6 л ты',
  'Продам 36л ты',
  'Отдам 3-6лать',
  'Кашпо 3-6лать',
  'Отдам горшки. 3-6 л',
  'Отдам\n3-6 л',
  'Отдам https://example.com 3-6 л',
  'Горшки https://example.com 3-6 л',
  'неотдам 3-6 л',
  'хуууй',
  'бляяять',
  'бблять',
  'ебаааать',
  'заееебал',
  'пииизда',
  'долбоооёб',
  'хууу*й',
  'заееeбал',
  'blyaaat',
  'huuuy',
  'zaeebal',
  'ты 3-6 л',
  '3-6лать',
  'Группа 3-6 л. для детей, блять',
  'Дети 3-6 л. А ты 36л',
  'Бак 3-6 л воды, а ты хуууй',
  '3-6лет,блять',
  'ЧЕТВЕРГ: 16:00 - гр. 3-6 л., блять',
  'ЧЕТВЕРГ: 16:00 - гр.3-6л.,хуууй',
  'Гр. 3-6 л. А ты 36л',
  'блять',
  'pohuy',
  'zaebal',
  'p1zda',
  'х*у*й',
  'б л я т ь',
  'б\0лять',
  'p\0izda',
  'х\0у\0й',
  'ты 36л',
  'ты 36 л',
  'Объем 36л, а ты 36л',
  'EBITDA выросла, но ты заебал',
  'Лампы Philips Hue хорошие, а ты pohuy пишешь',
  'https://example.com блять',
  'блять, напишите на hue@example.com',
  'Напишите на ebitda@company.ru, блять',
  'Блять <hue@example.com>',
  'блять, открой ebitda.csv',
  'Счет ebitda-2026.xlsx, блять',
  'Объем 36л, а ты е б а т ь пишешь.',
  'Бак 36л, ты 36л конечно.',
] as const;

const SEVERE_ABUSE_CONTROLS = [
  'Пидоров Павел выступил, а ты пидор',
  'https://example.com Мудаков Михаил выступил, а ты мудак',
  'Сукин Борис выступил, а ты сукин сын',
  'https://example.com Сукин Борис выступил, а ты сукин сын',
  'Мудак <hue@example.com>',
  'Напиши на hue@example.com, мудак',
  'Мудак, открой ebitda.csv',
  'Счет ebitda-2026.xlsx, а ты мудак',
  'Доска с сучками, а ты сука',
  'На доске сучки, а вы сучки',
] as const;

describe('profanity normalization false-positive regressions', () => {
  const previousRolloutMode = process.env.PROFANITY_V2_ROLLOUT_MODE;

  afterAll(() => {
    if (previousRolloutMode === undefined) {
      delete process.env.PROFANITY_V2_ROLLOUT_MODE;
    } else {
      process.env.PROFANITY_V2_ROLLOUT_MODE = previousRolloutMode;
    }
  });

  describe.each(['on', 'legacy'] as const)('%s rollout', (rolloutMode) => {
    beforeEach(() => {
      process.env.PROFANITY_V2_ROLLOUT_MODE = rolloutMode;
    });

    describe.each(['CORE_ONLY', 'BALANCED', 'STRICT'] as const)(
      '%s sensitivity',
      (profanitySensitivity) => {
        async function detectProfanity(text: string) {
          const service = new RuleEngineService({} as never);
          const result = await service.detect({
            chatId: 'chat-1',
            userId: 'user-1',
            text,
            settings: { ...BASE_SETTINGS, profanitySensitivity } as never,
            domainAllowlist: [],
          });
          return result.violations.find(({ ruleCode }) => ruleCode === 'PROFANITY');
        }

        it.each(SAFE_NORMALIZATION_CASES)('allows %s', async (text) => {
          expect(await detectProfanity(text)).toBeUndefined();
        });

        it.each(CORE_MAT_CONTROLS)('detects independent mat in %s', async (text) => {
          expect((await detectProfanity(text))?.metadata?.category).toBe('CORE_MAT');
        });

        it.each(SEVERE_ABUSE_CONTROLS)(
          'does not let an earlier surname exempt later abuse in %s',
          async (text) => {
            const expectedCategory =
              rolloutMode === 'on' && profanitySensitivity === 'CORE_ONLY'
                ? undefined
                : 'SEVERE_ABUSE';
            expect((await detectProfanity(text))?.metadata?.category).toBe(expectedCategory);
          },
        );
      },
    );
  });
});
