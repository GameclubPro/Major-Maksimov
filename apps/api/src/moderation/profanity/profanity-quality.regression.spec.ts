import { RuleEngineService } from '../rule-engine.service';
import { PROFANITY_SENSITIVITIES } from './profanity.types';

const CORE_CASES = [
  'е б у',
  'е б у я',
  'е б у. Я пошёл',
  'e b u',
  'e b u ya',
  'я е б у',
  'съебал',
  'съебись',
  'съёбывай',
  'отъебись',
  'отъебал',
  'подъебать',
  'взъебал',
  'разъебал',
  'объебал',
  'въебать',
  'выебу',
  'ебу',
  'наебу',
  'поебусь',
  'спиздил',
  'распиздяй',
  'отпиздили',
  'напиздел',
  'запизделся',
  'пропиздон',
  "s'ebal",
  'syebal',
  'otebis',
  'razebal',
  'spizdil',
  'raspizdyay',
  'ebat',
  'blyat',
  'bliad',
  'блять',
  'х*у*й',
  'пиздец',
  'blyadstvo',
  'zaebal',
] as const;

const SAFE_CASES = [
  'Т Р Е Б У Е Т С Я работник.',
  't r e b u e t s y a rabotnik',
  'х л е б у',
  'Т - Р - Е - Б - У - Е - Т - С - Я работник.',
  'Т Р Е Б У Ю ответ.',
  'Себальд написал роман',
  'Veblen effect',
  'Sebald wrote a book',
  'бляха на ремне',
  'блямба на стене',
  'blyaha na remne',
  'blyamba na stene',
  'blyaklyy cvet',
  'blyaher prishel',
  'себум защищает кожу',
  'себестоимость товара',
  'разъезд поездов',
  'подъезд дома',
  'объект готов',
  'отъезд завтра',
  'Питомник продает щенков. Сука привита и ищет дом.',
  'Сука овчарки ищет дом. Ты можешь забрать ее завтра.',
  'Питомник продаёт с у к у с родословной.',
  'Книга «Идиот» Достоевского есть в библиотеке.',
  'В зоопарке живет п.е.т.у.х.',
  'В детском центре а у т и с т пишет рассказ.',
  'В детском центре а.у.т.и.с.т пишет рассказ.',
  'Петух. Вы можете забрать его завтра.',
  'Подстрахуй меня, пожалуйста.',
] as const;

const SEVERE_CASES = [
  'Питомник продаёт щенков. Ты сука!',
  'Сука овчарки ищет дом. А ты сука, заткнись.',
  'Эти суки привиты. А вы суки, заткнись.',
  'Питомник продаёт щенков. Ты с у к а!',
  'Книга «Идиот» Достоевского. Ты идиот!',
  'Врач описал диагноз. Ты дебил, заткнись.',
  'На доске сучки. А вы с у ч к и!',
  'Ты п.е.т.у.х.',
  'Ты а у т и с т, заткнись.',
] as const;

const MILD_CASES = [
  'ты д у р а к',
  'ты д.у.р.а.к',
  'ты д_у_р_а_к',
  'д у р а к, уйди из чата',
  'ты к р е т и н',
  'ты л о х',
  'ты т у п о й',
  'ty d u r a k',
] as const;

describe('profanity quality regression pairs', () => {
  const service = new RuleEngineService({} as never);
  const previousRolloutMode = process.env.PROFANITY_V2_ROLLOUT_MODE;
  afterAll(() => {
    if (previousRolloutMode === undefined) delete process.env.PROFANITY_V2_ROLLOUT_MODE;
    else process.env.PROFANITY_V2_ROLLOUT_MODE = previousRolloutMode;
  });

  describe.each(['on', 'legacy'] as const)('%s rollout', (rolloutMode) => {
    beforeEach(() => {
      process.env.PROFANITY_V2_ROLLOUT_MODE = rolloutMode;
    });

    describe.each(PROFANITY_SENSITIVITIES)('%s sensitivity', (profanitySensitivity) => {
      const settings = { russianProfanityFilterEnabled: true, profanitySensitivity };
      const detect = (text: string) => service.detectProfanityForSettings(text, settings);

      it.each(CORE_CASES)('detects explicit mat: %s', (text) => {
        expect(detect(text)?.category).toBe('CORE_MAT');
      });
      it.each(SAFE_CASES)('allows literal or neutral context: %s', (text) => {
        expect(detect(text)).toBeNull();
      });
      it.each(SEVERE_CASES)('does not hide a separate attack: %s', (text) => {
        expect(detect(text)?.category).toBe(
          rolloutMode === 'legacy' || profanitySensitivity !== 'CORE_ONLY'
            ? 'SEVERE_ABUSE'
            : undefined,
        );
      });
      it.each(MILD_CASES)('keeps obfuscated direct insults scoped to STRICT: %s', (text) => {
        expect(detect(text)?.category).toBe(
          rolloutMode === 'legacy' || profanitySensitivity === 'STRICT' ? 'MILD_INSULT' : undefined,
        );
      });
    });
  });
});
