import { resolveCommercialAdsPolicy } from '@maxim/contracts/settings';
import { commercialAdsDetectionCategories } from './commercial/commercial-ads-runtime-policy.service';
import { Injectable, Optional } from '@nestjs/common';
import { TrafficProtectionDetector } from './traffic-protection.detector';
import {
  splitStopWordsSourceParagraphs,
  detectStopWordsViolations,
} from './stop-words/stop-words.detection';
import { isValidMaxBotStartPayload } from '../max/max-deep-link.util';
import type { ChatSettings } from '../prisma/prisma-client';
import {
  excludeProtectedProfanitySpans,
  getProfanityCandidateContext,
  getMeasurementLiteralContext,
  isEmbeddedShortProfanityFragment,
  isLiteralLatinProfanityException,
  prepareProfanitySource,
  tokenizeProfanityContext,
  type ProfanitySourceCandidate,
} from './profanity/profanity-source-context';
import { RuntimeDiagnosticsService } from '../system/runtime-diagnostics.service';
import { CommercialAdDetector } from './commercial';
import {
  CommercialTextRuntimePolicyService,
  fingerprintCommercialTextSettingsProfile,
  COMMERCIAL_TEXT_BASELINE_POLICY_COHORTS,
} from './commercial/commercial-text-runtime-policy.service';
import type { CommercialCampaignContext } from './commercial-campaign.util';
import {
  resolveExactProfanityVariantFamily,
  resolveTargetedInsultVariantFamily,
} from './profanity-lexicon';
import {
  classifyProfanityVariant,
  createProfanityDecision,
  isProfanityCategoryEnabled,
  resolveProfanityRolloutMode,
  resolveProfanitySensitivity,
} from './profanity/profanity-policy';
import type {
  ProfanityDetectionDecision,
  ProfanityEvidence,
  ProfanityMatchKind,
  ProfanityRolloutMode,
  ProfanitySensitivity,
} from './profanity/profanity.types';
import { RedisCounterService } from './redis-counter.service';
import { createRuleDetectionContext } from './rule-engine-detection-context';
import { isEnforceableLinkPolicyTarget } from './navigation/link-policy-target.util';
import type { NavigationTargetEvidence } from './navigation/navigation-evidence.types';
import { RuleEngineDuplicateDetector } from './rule-engine-duplicate-detector';
import type { DetectionResult, RuleViolation } from './rule-engine.contract';
import { hasCompetingModerationViolation } from './moderation-rule-competition';
import {
  prepareLinkAllowlist,
  detectBlockedLink,
  extractUrlsFromText,
} from './rule-engine-link-detector';
import {
  extractDetectedPhoneNumbers as extractLegacyDuplicatePhoneNumbers,
  RuleEngineMessageLimitsDetector,
} from './rule-engine-message-limits.detector';
import {
  MIXED_CHAR_MAP,
  normalizeForDetection,
  normalizeMixedWriting,
} from './rule-engine-normalization';
import {
  createRuleEngineDetectProfile,
  logSlowRuleEngineDetectIfNeeded,
  markRuleEngineDetectStage,
  recordRuleEngineDetectProfile,
} from './rule-engine-profile';

type ProfanityCandidate = ProfanitySourceCandidate;

type ProfanityCorePattern = {
  familyId: string;
  pattern: RegExp;
};

// Keep regexes only for highly productive mat roots. Closed-form insults and slurs
// should come from the exact lexicon so names/surnames with the same prefix do not match.
const PROFANITY_CORE_TOKEN_PATTERNS: readonly ProfanityCorePattern[] = [
  { familyId: 'core:blyad', pattern: /^бля(?:[дт][а-я0-9]*)?$/u },
  {
    familyId: 'core:pizd',
    pattern: /^(?:с|рас|раз|от|на|за|по|про|вы|пере|до|при|под|об)?пизд[а-я0-9]*$/u,
  },
  {
    familyId: 'core:huy',
    pattern: /^(?:на|по|до|о|а|за|ни|вы|при|под|пере|раз|об)?ху(?:й|е|я|и|ю)[а-я0-9]*$/u,
  },
  {
    familyId: 'core:yeb',
    pattern:
      /^(?:(?:за|вы|на|по|до|пере|про|об|раз|под|у)ъ?|(?:с|от|в|вз)[ъь])?(?:[её]|йо|йе)б(?:а(?:л|ть|н|ш|ч)|е(?:т|шь|м|те)|у(?:т|ч|н|сь|$)|и(?:сь|т|те)|л(?:ан|о|и)?|н(?:у|ут)|о(?:н|ны)|щ|уч|ыва)[а-я0-9]*$/u,
  },
  { familyId: 'core:dolboyeb', pattern: /^долбо(?:[её]б)[а-я0-9]*$/u },
];
const PROFANITY_LATIN_TOKEN_PATTERNS: readonly ProfanityCorePattern[] = [
  { familyId: 'core:blyad', pattern: /^bl(?:ya|ia)(?:[dt][a-z0-9]*)?$/i },
  {
    familyId: 'core:pizd',
    pattern: /^(?:s|ras|raz|ot|na|za|po|pro|vy|pere|do|pri|pod|ob)?pizd[a-z0-9]*$/i,
  },
  {
    familyId: 'core:huy',
    pattern:
      /^(?:na|po|do|o|a|za|ni|vy|pri|pod|pere|raz|ob)?(?:h|x)(?:u|oo|y)(?:y|j|i|e|ya|yu)[a-z0-9]*$/i,
  },
  {
    familyId: 'core:yeb',
    pattern:
      /^(?:za|vy|na|po|do|pere|pro|ob|raz|pod|u)?e+b(?:a(?:l|t|n|sh|ch)|e(?:t|sh|m|te)|u(?:t|ch|n|s|$)|i(?:s|t|te)|l(?:an|o|i)?|n(?:u|ut)|uch|yva)[a-z0-9]*$/i,
  },
  // FLAG: Consonant-prefix transliterations need complete verb endings: broad sebal*/vebl*
  // roots also match the ordinary names Sebald and Veblen.
  {
    familyId: 'core:yeb',
    pattern:
      /^(?:s|ot|v|vz)(?:ye|yo|e)b(?:al(?:a|o|i)?|at(?:sya)?|is(?:ya)?|ite(?:s)?|yva(?:y(?:te)?|l[aoiy]?|t(?:sya)?)|u(?:t|s)?)$/i,
  },
  { familyId: 'core:dolboyeb', pattern: /^dolboe+b[a-z0-9]*$/i },
];
const PROFANITY_CANINE_FEMALE_FORMS = new Set([
  'сука',
  'суки',
  'суке',
  'суку',
  'сукой',
  'сукою',
  'сучка',
  'сучки',
  'сучке',
  'сучку',
  'сучкой',
  'сучкою',
  'сучек',
  'сучкам',
  'сучками',
  'сучках',
  'сучонок',
  'сучонка',
  'сучонку',
  'сучонком',
  'сучонки',
]);
const PROFANITY_CANINE_CONTEXT_MARKERS = [
  'собак',
  'щен',
  'стерилиз',
  'кастрир',
  'привит',
  'пород',
  'паспорт',
  'в добрые руки',
  'отдается',
  'отдаётся',
  'охранниц',
  'кошк',
  'котят',
  'питомник',
];
const PROFANITY_CANINE_STRONG_CONTEXT_MARKERS = [
  'собак',
  'щен',
  'овчарк',
  'терьер',
  'йоркшир',
  'стерилиз',
  'кастрир',
  'привит',
  'питомник',
  'родословн',
];
const PROFANITY_CANINE_LISTING_CONTEXT_MARKERS = [
  'ищет дом',
  'ищут дом',
  'в добрые руки',
  'отдам',
  'отдается',
  'отдаётся',
  'продам',
  'пристро',
  'потерял',
  'найден',
  'самка',
  'кобел',
  'кобель',
  'порода',
];
const PROFANITY_REACH_TYPO_CONTEXT_MARKERS = [
  'охват',
  'подписчик',
  'подписчиков',
  'размещен',
  'размещение',
  'канал',
  'реклам',
  'пост',
  'спм',
  'cpm',
];
const PROFANITY_LIVESTOCK_FORMS = new Set([
  'скотина',
  'скотины',
  'скотине',
  'скотину',
  'скотиной',
  'скотиною',
  'скотинам',
  'скотинами',
  'скотинах',
]);
const PROFANITY_LIVESTOCK_CONTEXT_MARKERS = [
  'ферм',
  'крс',
  'коров',
  'быч',
  'телк',
  'телят',
  'овц',
  'коз',
  'свин',
  'стад',
  'пастбищ',
  'выпас',
  'хлев',
  'стойл',
  'хозяйств',
  'выращен',
  'откорм',
  'комбикорм',
  'надой',
];
const PROFANITY_LIVESTOCK_STRONG_CONTEXT_MARKERS = [
  'ферм',
  'крс',
  'выпас',
  'пастбищ',
  'коров',
  'быч',
  'телят',
  'овц',
  'коз',
  'свин',
  'хозяйств',
  'ветеринар',
  'привит',
];
const PROFANITY_LIVESTOCK_LISTING_CONTEXT_MARKERS = [
  'продам',
  'продается',
  'продаётся',
  'куплю',
  'хозяйств',
  'ферм',
  'крс',
  'поголов',
  'скотн',
  'животновод',
];
const PROFANITY_PARASITE_FORMS = new Set(['гнида', 'гниды', 'гниде', 'гниду', 'гнидой', 'гнидою']);
const PROFANITY_PARASITE_CONTEXT_MARKERS = [
  'мошк',
  'комар',
  'укус',
  'укус',
  'насеком',
  'вош',
  'вши',
  'клещ',
  'паразит',
  'личин',
];
const PROFANITY_PARASITE_STRONG_CONTEXT_MARKERS = [
  'мошк',
  'комар',
  'укус',
  'насеком',
  'вош',
  'вши',
  'клещ',
  'паразит',
  'личин',
];
const PROFANITY_GARDEN_PEST_FORMS = new Set([
  'тварь',
  'твари',
  'тварей',
  'тварям',
  'тварями',
  'тварях',
]);
const PROFANITY_GARDEN_PEST_CONTEXT_MARKERS = [
  'клубник',
  'огород',
  'сад',
  'растен',
  'вредител',
  'насеком',
  'жрут',
  'напали',
  'актар',
  'избавиться',
  'урожай',
  'листв',
];
const PROFANITY_GARDEN_PEST_STRONG_CONTEXT_MARKERS = [
  'клубник',
  'огород',
  'сад',
  'растен',
  'вредител',
  'насеком',
  'урожай',
  'листв',
];
const PROFANITY_AXIS_DIMENSION_FORMS = new Set(['хуи', 'хуиз', 'хуизна']);
const PROFANITY_AXIS_DIMENSION_CONTEXT_MARKERS = [
  'осям',
  'ось',
  'координат',
  'габарит',
  'размер',
  'оси',
  'мм',
  'дхш',
  'дхв',
];
const PROFANITY_PROPER_NAME_FORMS = new Set([
  'сукин',
  'сукина',
  'сукину',
  'сукиным',
  'мудаков',
  'дебилов',
  'идиотов',
  'уродов',
  'пидоров',
  'лохов',
  'mudakov',
  'debilov',
  'idiotov',
  'urodov',
  'pidorov',
  'lohov',
  'lokhov',
]);
const PROFANITY_PROPER_NAME_CONTEXT_MARKERS = [
  'фамил',
  'имя',
  'отчеств',
  'паспорт',
  'документ',
  'анкета',
  'резюме',
  'автор',
  'художник',
  'писател',
  'доктор',
  'врач',
  'мастер',
  'тренер',
  'учител',
  'преподавател',
  'директор',
  'менеджер',
  'записан',
  'запись',
  'прием',
  'приём',
  'улиц',
  'переул',
  'проспект',
  'село',
  'деревн',
  'посел',
  'иван',
  'андрей',
  'анна',
  'олег',
  'мария',
  'сергей',
  'петрович',
  'иванович',
  'ivan',
  'anna',
  'andrey',
  'sergey',
  'doctor',
  'достор',
  'street',
  'стреет',
  'author',
  'аутхор',
  'coach',
  'соасх',
];
const PROFANITY_PROPER_NAME_STANDALONE_CONTEXT_MARKERS = [
  ...PROFANITY_PROPER_NAME_CONTEXT_MARKERS,
  'пришел',
  'пришла',
  'пришли',
  'подтвердил',
  'подтвердила',
  'подтвердили',
  'заказ',
  'заявк',
  'документ',
  'регистрац',
  'перенес',
  'перенесла',
  'оставил',
  'оставила',
  'отправил',
  'отправила',
  'указан',
  'указана',
  'подписал',
  'подписала',
];
const PROFANITY_BOTANY_AND_PLACE_FORMS = new Set([
  'лох',
  'лоха',
  'лоху',
  'лохом',
  'лохи',
  'лохов',
  'loh',
  'lohu',
  'lokh',
  'lokhu',
]);
const PROFANITY_BOTANY_AND_PLACE_CONTEXT_MARKERS = [
  'узколист',
  'серебрист',
  'растен',
  'сажен',
  'куст',
  'питомник',
  'ягод',
  'ботан',
  'гербар',
  'сад',
  'несс',
  'шотланд',
  'озер',
  'замок',
  'село',
  'истор',
  'архив',
  'loch ness',
  'plant',
  'garden',
];
const PROFANITY_CLINICAL_FORMS = new Set([
  'дебил',
  'дебила',
  'дебилу',
  'дебилом',
  'дебилы',
  'дебильный',
  'дебильная',
  'дебильное',
  'дебильные',
  'идиот',
  'идиота',
  'идиоту',
  'идиотом',
  'идиоты',
  'идиотизм',
  'идиотизма',
  'идиотизму',
  'имбецил',
  'имбецила',
  'имбецилу',
  'имбецилом',
  'имбецилы',
  'имбецильный',
  'имбецильная',
  'имбецильное',
  'имбецильные',
  'кретин',
  'кретина',
  'кретину',
  'кретином',
  'кретины',
  'дегенерат',
  'дегенерата',
  'дегенерату',
  'дегенератом',
  'дегенераты',
]);
const PROFANITY_CLINICAL_CONTEXT_MARKERS = [
  'мкб',
  'диагноз',
  'диагност',
  'пациент',
  'анамнез',
  'психиатр',
  'невролог',
  'олигофрен',
  'расстройств',
  'синдром',
  'термин',
  'учебник',
  'лекци',
  'истори',
  'медицин',
  'клиник',
  'заключени',
  'справк',
];
const PROFANITY_SELF_DIRECTED_MILD_INSULT_FORMS = new Set([
  'кретин',
  'кретином',
  'кретинка',
  'кретинкой',
]);
const PROFANITY_SELF_REFERENCE_MARKERS = new Set(['я', 'мне', 'меня', 'себя', 'себе', 'собой']);
const PROFANITY_SELF_REFERENCE_BRIDGE_TOKENS = new Set([
  'же',
  'ж',
  'тоже',
  'сам',
  'сама',
  'самый',
  'самая',
  'прям',
  'прямо',
  'реально',
  'просто',
  'вроде',
  'наверное',
  'получается',
  'значит',
  'не',
]);
const PROFANITY_COMPLETION_FORMS = new Set([
  'конченый',
  'конченая',
  'конченое',
  'конченые',
  'конченный',
  'конченная',
  'конченное',
  'конченные',
  'конченного',
  'конченному',
  'конченную',
  'конченным',
  'конченных',
]);
const PROFANITY_COMPLETION_CONTEXT_MARKERS = [
  'заверш',
  'готов',
  'файл',
  'выгрузк',
  'документ',
  'работ',
  'ремонт',
  'проект',
  'этап',
  'процесс',
  'заказ',
  'архив',
  'строк',
  'статус',
];
const PROFANITY_LITERARY_TITLE_FORMS = new Set(['идиот', 'идиота', 'идиоту', 'идиотом']);
const PROFANITY_LITERARY_TITLE_CONTEXT_MARKERS = [
  'роман',
  'книг',
  'литератур',
  'достоевск',
  'произведени',
  'экранизац',
  'фильм',
  'спектакл',
  'театр',
  'названи',
  'цитат',
  'персонаж',
  'глав',
];
const PROFANITY_LATIN_CULTURAL_NAME_FORMS = new Set([
  'suki',
  'suke',
  'suku',
  'manda',
  'mandi',
  'mande',
  'mandu',
]);
const PROFANITY_CYRILLIC_CULTURAL_NAME_FORMS = new Set(['суки', 'манда', 'манду', 'манди']);
const PROFANITY_LATIN_CULTURAL_NAME_CONTEXT_MARKERS = [
  'sushi',
  'суши',
  'сусхи',
  'roll',
  'ролл',
  'tokyo',
  'токио',
  'токуо',
  'japan',
  'япони',
  'йапан',
  'bali',
  'бали',
  'hotel',
  'хотел',
  'house',
  'хоусе',
  'хаус',
  'cafe',
  'restaurant',
  'кафе',
  'ресторан',
  'отель',
  'бренд',
  'блюдо',
  'рис',
  'открыл',
  'открыт',
  'рядом',
  'меню',
  'доставк',
];
const PROFANITY_EXCEPTIONS = [
  'бляха',
  'бляхер',
  'бляхой',
  'страхуй',
  'подстрахуй',
  'застрахуй',
  'страхуем',
  'страхуя',
  'педикюр',
  'сукно',
  'сукон',
  'скипидар',
  'дебилитац',
  'идиомат',
];
const PROFANITY_SHORT_JOINABLE_TOKENS = new Set([
  'б',
  'бл',
  'бля',
  'л',
  'я',
  'д',
  'дь',
  'т',
  'ть',
  'п',
  'пид',
  'пидо',
  'пед',
  'педо',
  'педа',
  'пиз',
  'и',
  'з',
  'х',
  'у',
  'убл',
  'блю',
  'юд',
  'й',
  'е',
  'ё',
  'еб',
  'ебл',
  'еба',
  'ебан',
  'деб',
  'диб',
  'дол',
  'дал',
  'бол',
  'бал',
  'бо',
  'ба',
  'рас',
  'раз',
  'на',
  'по',
  'до',
  'о',
  'за',
  'ни',
  'вы',
  'об',
  'раз',
  'под',
  'про',
  'у',
]);
const PROFANITY_LATIN_JOINABLE_TOKENS = new Set([
  'b',
  'bl',
  'bly',
  'l',
  'y',
  'ya',
  'a',
  't',
  'd',
  'p',
  'pi',
  'piz',
  'pid',
  'pido',
  'pedo',
  'ped',
  'h',
  'x',
  'hu',
  'hy',
  'hui',
  'u',
  'e',
  'eb',
  'eba',
  'eban',
  'za',
  'dol',
  'dal',
  'bo',
  'ba',
  'bol',
  'bal',
  'ras',
  'raz',
  'mud',
  'muda',
  'mraz',
  'ub',
  'ubl',
  'blyu',
  'yud',
  'de',
  'deb',
  'di',
  'dib',
  'id',
  'idi',
  'ot',
  'suk',
  'su',
  'ka',
]);
const PROFANITY_JOIN_WINDOW_SEGMENTS = 14;
const PROFANITY_JOIN_MAX_FRAGMENTS = 8;
const PROFANITY_JOIN_NOISE_BUDGET = 12;
const PROFANITY_NUMERIC_LIST_PATTERN =
  /(?<![\p{L}\p{N}])\d{2,}(?:[\s.,;:/-]+\d{2,})+(?![\p{L}\p{N}])/gu;
const PROFANITY_DIRECT_ADDRESS_MARKERS = new Set([
  'ты',
  'вы',
  'тебя',
  'тебе',
  'тобой',
  'вас',
  'вам',
  'вами',
  'ty',
  'ti',
  'vy',
  'vi',
  'tebya',
  'tebe',
  'vas',
  'vam',
]);
const PROFANITY_TARGET_BRIDGE_TOKENS = new Set([
  'же',
  'ж',
  'прям',
  'прямо',
  'реально',
  'просто',
  'полный',
  'полная',
  'полное',
  'полные',
  'конченый',
  'конченный',
  'конченая',
  'конченная',
  'конченое',
  'конченное',
  'тупой',
  'тупая',
  'тупое',
  'тупые',
  'жалкий',
  'жалкая',
  'жалкое',
  'жалкие',
  'настоящий',
  'настоящая',
  'настоящее',
  'настоящие',
  'какой',
  'какая',
  'какое',
  'какие',
  'все',
  'всё',
  'какой-то',
  'какая-то',
  'какое-то',
  'какие-то',
  'то',
  'vse',
  'same',
  'sam',
  'realno',
  'prosto',
  'polnyy',
  'polnaya',
]);
const PROFANITY_DEMONSTRATIVE_TARGET_MARKERS = new Set(['этот', 'эта', 'эти', 'тот', 'та', 'те']);
const PROFANITY_NEUTRAL_MODIFIER_FORMS = new Set([
  'жирный',
  'жирная',
  'жирное',
  'жирные',
  'глупый',
  'глупая',
  'глупое',
  'глупые',
  'тупой',
  'тупая',
  'тупое',
  'тупые',
]);
const PROFANITY_NEUTRAL_MODIFIER_NOUNS = new Set([
  'шрифт',
  'текст',
  'вопрос',
  'ответ',
  'угол',
  'уголок',
  'карандаш',
  'карандаша',
  'карандашом',
  'лезвие',
  'лезвия',
  'нож',
  'ножа',
  'маркер',
  'фломастер',
  'инструмент',
  'предмет',
  'вариант',
  'пример',
  'запрос',
]);
const PROFANITY_THIRD_PERSON_TARGET_MARKERS = new Set([
  'он',
  'она',
  'оно',
  'они',
  'его',
  'ее',
  'её',
  'их',
]);
const PROFANITY_THIRD_PERSON_SAFE_TOKENS = new Set([
  'диагноз',
  'синдром',
  'расстройство',
  'термин',
  'порода',
  'ферма',
  'питомник',
  'скот',
]);
const PROFANITY_NEUTRAL_IDENTITY_FORMS = new Set([
  'аутист',
  'аутиста',
  'аутисту',
  'аутистом',
  'аутисты',
  'аутистов',
  'аутистам',
  'аутистами',
  'аутистах',
  'аутистка',
  'аутистки',
  'аутистке',
  'аутистку',
  'аутисткой',
  'псих',
  'психа',
  'психу',
  'психом',
  'психи',
  'психов',
  'психам',
  'психами',
  'психах',
  'алкоголик',
  'алкоголика',
  'алкоголику',
  'алкоголиком',
  'алкоголики',
  'алкоголичка',
  'алкоголички',
  'алкоголичку',
  'наркоман',
  'наркомана',
  'наркоману',
  'наркоманом',
  'наркоманы',
  'наркоманка',
  'наркоманки',
  'наркоманку',
]);
const PROFANITY_NEUTRAL_PREDICATES = new Set(['пишет', 'пришел', 'пришла', 'пришли']);
const PROFANITY_HOSTILE_AFTER_TARGET_TOKENS = new Set([
  'уйди',
  'вали',
  'свали',
  'заткнись',
  'молчи',
  'исчезни',
  'проваливай',
  'отстань',
  'достал',
  'достала',
  'достали',
  'спамишь',
  'спамит',
  'пишешь',
  'пишет',
  'лезешь',
  'лезет',
  'приперся',
  'приперлась',
  'приперлись',
  'пришел',
  'пришла',
  'пришли',
]);
const DUPLICATE_COMMAND_ONLY_PATTERN = /^\s*\/[\p{L}\p{N}_]+(?:@[\p{L}\p{N}_]+)?\s*$/u;
const DUPLICATE_START_WITH_PAYLOAD_PATTERN = /^\s*\/start(?:@[\p{L}\p{N}_]+)?\s+(\S+)\s*$/iu;
const DUPLICATE_EXACT_MIN_SIGNAL_CHARACTERS = 2;
const DUPLICATE_MIN_LENGTH = 50;
const DUPLICATE_MIN_TOKEN_COUNT = 6;
const DUPLICATE_MIN_UNIQUE_LONG_TOKENS = 4;
const PROFANITY_AMBIGUOUS_MIXED_CHAR_MAP: Record<string, string> = {
  ...MIXED_CHAR_MAP,
  '!': 'и',
  '|': 'и',
  '@': 'я',
  '9': 'я',
  p: 'р',
  u: 'и',
  y: 'я',
};
const PROFANITY_PHONETIC_MIXED_CHAR_MAP: Record<string, string> = {
  ...PROFANITY_AMBIGUOUS_MIXED_CHAR_MAP,
  p: 'п',
};
const PROFANITY_LEET_MIXED_CHAR_MAP: Record<string, string> = {
  ...PROFANITY_AMBIGUOUS_MIXED_CHAR_MAP,
  '3': 'е',
  '4': 'ч',
  '€': 'е',
  '₽': 'р',
  '¥': 'у',
};
const PROFANITY_EXTRA_CHAR_MAP: Record<string, string> = {
  і: 'и',
  ї: 'и',
  є: 'е',
  ґ: 'г',
};
const PROFANITY_LATIN_LEET_CHAR_MAP: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '!': 'i',
  '|': 'i',
  '3': 'e',
  '4': 'a',
  '@': 'a',
  '5': 's',
  $: 's',
  '6': 'b',
  '7': 't',
  '8': 'b',
  '9': 'g',
  '€': 'e',
  '₽': 'p',
  '¥': 'y',
};
const PROFANITY_SIZE_NOTATION_CONTEXT_MARKERS = [
  'размер',
  'обув',
  'босонож',
  'туфл',
  'кроссов',
  'ботин',
  'сапог',
  'пара',
  'цена',
  'руб',
];
const PROFANITY_HORSEPOWER_CONTEXT_MARKERS = [
  'мощност',
  'двигател',
  'мотор',
  'бензопил',
  'лодочн',
  'лошадин',
  'лс',
];
const PROFANITY_SIZE_RANGE_NOTATION_PATTERN =
  /(?:^|[^\p{L}\p{N}])(?:р\.?\s*)?(?:2[0-9]|3[0-9]|4[0-9]|5[0-2])\s*[/-]\s*(?:2[0-9]|3[0-9]|4[0-9]|5[0-2])\s*(?:р\.?|разм(?:ер)?\.?)?(?=$|[^\p{L}\p{N}])/iu;
const PROFANITY_HORSEPOWER_NOTATION_PATTERN =
  /(?:^|[^\p{L}\p{N}])\d{1,3}(?:[,.]\d{1,2})?\s*(?:л\.?\s*с\.?|лс)(?=$|[^\p{L}\p{N}])/iu;
const PROFANITY_CODE_CONTEXT_MARKERS = [
  'код',
  'артикул',
  'номер',
  'заявк',
  'таблиц',
  'строк',
  'поле',
  'форм',
  'маркировк',
  'модель',
  'серия',
];

@Injectable()
export class RuleEngineService {
  private readonly duplicateDetector: RuleEngineDuplicateDetector;
  private readonly messageLimitsDetector: RuleEngineMessageLimitsDetector;
  private readonly trafficProtectionDetector: TrafficProtectionDetector;
  private readonly commercialAdDetector = new CommercialAdDetector();

  constructor(
    private readonly redisCounter: RedisCounterService,
    @Optional() private readonly runtimeDiagnosticsService?: RuntimeDiagnosticsService,
    @Optional() private readonly commercialTextPolicy?: CommercialTextRuntimePolicyService,
  ) {
    this.duplicateDetector = new RuleEngineDuplicateDetector(redisCounter, () => {
      void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
        stage: 'rule-engine.duplicate-state',
        outcome: 'timeout',
      });
    });
    this.messageLimitsDetector = new RuleEngineMessageLimitsDetector(
      redisCounter,
      ({ rule, reason }) =>
        this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
          stage: `rule-engine.${rule}`,
          outcome: reason === 'deadline' ? 'timeout' : 'skip',
          failOpen: true,
        }),
    );
    this.trafficProtectionDetector = new TrafficProtectionDetector(redisCounter);
  }

  async detect(params: {
    chatId: string;
    userId: string;
    messageId?: string;
    duplicateStateEventType?: 'message_created' | 'message_edited';
    duplicateStateEventTimestampMs?: number;
    text: string;
    settings: ChatSettings;
    domainAllowlist: string[];
    navigationTargets?: readonly NavigationTargetEvidence[];
    stopWordsTextSegments?: readonly string[];
    effectiveLength?: number;
    hasPhotoAttachment?: boolean;
    hasStickerAttachment?: boolean;
    hasVideoAttachment?: boolean;
    hasFileAttachment?: boolean;
    hasVoiceAttachment?: boolean;
    hasForwardedMessage?: boolean;
    hasMediaBatch?: boolean;
    mediaGroupId?: string | null;
    messageCountPublicationId?: string | null;
    skipAntiSpamBurstLimit?: boolean;
    skipDuplicateState?: boolean;
    skipStatefulMessageLimits?: boolean;
    skipContentFiltersForReport?: boolean;
    commercialCampaignContext?: CommercialCampaignContext | null;
  }): Promise<DetectionResult> {
    const {
      chatId,
      userId,
      messageId,
      duplicateStateEventType,
      duplicateStateEventTimestampMs,
      text,
      settings,
      domainAllowlist,
      navigationTargets,
      effectiveLength,
      hasPhotoAttachment,
      hasStickerAttachment,
      hasVideoAttachment,
      hasFileAttachment,
      hasVoiceAttachment,
      hasForwardedMessage,
      hasMediaBatch,
      skipAntiSpamBurstLimit,
      skipDuplicateState,
      skipStatefulMessageLimits: requestedSkipStatefulMessageLimits,
      commercialCampaignContext,
    } = params;
    // FLAG: An edit never spends rate quota, even if its caller omits or clears the skip hint.
    const skipStatefulMessageLimits =
      requestedSkipStatefulMessageLimits === true || duplicateStateEventType === 'message_edited';
    const hasAntiSpamBurstExcludedAttachment = Boolean(
      hasPhotoAttachment ||
      hasVideoAttachment ||
      hasFileAttachment ||
      hasVoiceAttachment ||
      hasMediaBatch,
    );
    const profile = createRuleEngineDetectProfile();
    const violations: RuleViolation[] = [];
    const detectionContext = createRuleDetectionContext({
      text,
      settings,
      effectiveLength,
    });
    markRuleEngineDetectStage(profile, 'normalize');

    // FLAG: A recognized report command still passes all rate, length and attachment limits.
    const profanityDecision = params.skipContentFiltersForReport
      ? null
      : this.detectProfanityForSettings(text, settings);
    if (profanityDecision) {
      violations.push({
        ruleCode: 'PROFANITY',
        score: profanityDecision.score,
        reason: 'Detected profanity or abusive language pattern',
        metadata: {
          category: profanityDecision.category,
          sensitivity: profanityDecision.sensitivity,
          rolloutMode: profanityDecision.rolloutMode,
          familyId: profanityDecision.familyId,
          matchKind: profanityDecision.matchKind,
          matchedVariant: profanityDecision.matchedVariant,
          evidence: profanityDecision.evidence,
          detectorVersion: profanityDecision.detectorVersion,
        },
      });
    }
    markRuleEngineDetectStage(profile, 'profanity');

    if (settings.commercialAdsFilterEnabled && !params.skipContentFiltersForReport) {
      const authority = await this.commercialTextPolicy?.authority(
        params.chatId,
        fingerprintCommercialTextSettingsProfile(settings),
      );
      const commercial = this.commercialAdDetector.detect({
        normalizedText: detectionContext.normalizedText,
        rawLoweredText: detectionContext.rawLoweredText,
        settings,
        commercialCampaignContext,
        promotedPolicyCohorts:
          authority?.promotedPolicyCohorts ?? COMMERCIAL_TEXT_BASELINE_POLICY_COHORTS,
      });
      if (commercial) {
        const categories = commercialAdsDetectionCategories(commercial);
        const categoryPolicy = resolveCommercialAdsPolicy({
          policy: settings.commercialAdsPolicy,
          categories,
          userId,
        });
        const categoryActionable =
          categoryPolicy.decision === 'LEGACY' || categoryPolicy.decision === 'BLOCK';
        violations.push({
          ruleCode: 'COMMERCIAL_AD',
          score: commercial.confidenceScore / 100,
          reason: 'Detected Russian commercial ad pattern',
          metadata: {
            commercialAdsCategories: categories,
            commercialAdsPolicyReason: categoryPolicy.reason,
            confidenceScore: commercial.confidenceScore,
            decisionBand: commercial.decisionBand,
            matchedSignals: commercial.matchedSignals,
            negativeSignals: commercial.negativeSignals,
            primarySubtype: commercial.primarySubtype,
            supportingSubtypes: commercial.supportingSubtypes,
            evidenceStrength: commercial.evidenceStrength,
            reviewRecommended: commercial.reviewRecommended,
            reviewReasons: commercial.reviewReasons,
            classifierVersion: commercial.classifierVersion,
            commercialProbability: commercial.commercialProbability,
            reviewProbability: commercial.reviewProbability,
            classifierReasons: commercial.classifierReasons,
            ...(commercial.campaignContext ? { campaignContext: commercial.campaignContext } : {}),
            appliedThresholds: commercial.appliedThresholds,
            decisionVersion: commercial.decisionVersion,
            score: commercial.score,
            actionScore: commercial.actionScore,
            fpRisk: commercial.fpRisk,
            policyFpRisk: commercial.policyFpRisk,
            evidenceTier: commercial.evidenceTier,
            subtype: commercial.subtype,
            actionBand:
              authority?.baselineAllowed === false || !categoryActionable
                ? 'REVIEW_ONLY'
                : commercial.actionBand,
            messageDisposition:
              authority?.baselineAllowed === false || !categoryActionable
                ? 'KEEP'
                : commercial.messageDisposition,
            commercialTextRuntimeRevision: authority?.revision ?? 0,
            commercialTextRuntimeMode: authority?.mode ?? 'baseline',
            requiredPolicyCohorts: commercial.requiredPolicyCohorts ?? [],
            reviewPriority: commercial.reviewPriority,
            campaignStrength: commercial.campaignStrength,
            safeContextBucket: commercial.safeContextBucket,
            actionable:
              authority?.baselineAllowed !== false && categoryActionable && commercial.actionable,
            recordable:
              authority?.baselineAllowed !== false && categoryActionable && commercial.recordable,
            deleteSuppressed: commercial.deleteSuppressed,
            suppressionReasons: commercial.suppressionReasons,
            reasonCodes: commercial.reasonCodes,
            featureVector: commercial.featureVector,
          },
        });
      }
    }
    markRuleEngineDetectStage(profile, 'commercial-ad');

    const preparedAllowlist =
      domainAllowlist.length > 0 ? prepareLinkAllowlist(domainAllowlist) : undefined;
    const allowlistLinkMatcher = preparedAllowlist?.link;
    const linkViolation = detectBlockedLink(
      text,
      settings.linkPolicy,
      domainAllowlist,
      preparedAllowlist,
      navigationTargets,
      settings.linkRulesPolicy,
    );
    if (linkViolation) {
      violations.push({ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: linkViolation });
    }
    markRuleEngineDetectStage(profile, 'links');

    const messageLengthViolation = this.messageLimitsDetector.detectMessageLengthLimit({
      measuredLength: detectionContext.measuredLength,
      settings,
    });
    if (messageLengthViolation) {
      violations.push(messageLengthViolation);
    }
    markRuleEngineDetectStage(profile, 'message-length');

    const antiSpamViolation = skipStatefulMessageLimits
      ? null
      : await this.messageLimitsDetector.detectAntiSpamBurstLimit({
          chatId,
          userId,
          messageId,
          eventTimestampMs: duplicateStateEventTimestampMs,
          settings,
          hasExcludedAttachment: hasAntiSpamBurstExcludedAttachment,
          skipAntiSpamBurstLimit,
        });
    if (antiSpamViolation) {
      violations.push(antiSpamViolation);
    }
    markRuleEngineDetectStage(profile, 'anti-spam-burst');

    const messageCountViolation = skipStatefulMessageLimits
      ? null
      : await this.messageLimitsDetector.detectMessageCountLimit({
          chatId,
          userId,
          messageId,
          ...(hasPhotoAttachment &&
          duplicateStateEventType === 'message_created' &&
          params.messageCountPublicationId
            ? { publicationId: params.messageCountPublicationId }
            : {}),
          eventTimestampMs: duplicateStateEventTimestampMs,
          settings,
        });
    if (messageCountViolation) {
      violations.push(messageCountViolation);
    }
    markRuleEngineDetectStage(profile, 'message-count-limit');

    let blockedWordViolation: RuleViolation | null = null;
    let blockedDomainViolation: RuleViolation | null = null;
    if (settings.stopWordsPolicy == null && !params.skipContentFiltersForReport) {
      for (const segment of splitStopWordsSourceParagraphs({
        text,
        textSegments: params.stopWordsTextSegments,
      })) {
        blockedWordViolation ??= this.messageLimitsDetector.detectBlockedWordLimit({
          text: segment,
          settings,
        });
        blockedDomainViolation ??= this.messageLimitsDetector.detectBlockedDomainLimit({
          text: segment,
          settings,
          isLinkAllowlisted: allowlistLinkMatcher,
        });
        if (blockedWordViolation && blockedDomainViolation) break;
      }
    }
    if (blockedWordViolation) {
      violations.push(blockedWordViolation);
    }
    markRuleEngineDetectStage(profile, 'blocked-words');

    if (blockedDomainViolation) {
      violations.push(blockedDomainViolation);
    }
    markRuleEngineDetectStage(profile, 'blocked-domains');
    if (settings.stopWordsPolicy != null && !params.skipContentFiltersForReport) {
      violations.push(
        ...detectStopWordsViolations({
          text,
          settings,
          textSegments: params.stopWordsTextSegments,
          navigationTargets,
          isLinkAllowlisted: allowlistLinkMatcher,
        }),
      );
    }

    const phoneNumberViolation = params.skipContentFiltersForReport
      ? null
      : this.messageLimitsDetector.detectPhoneNumberLimit({
          text,
          settings,
        });
    if (phoneNumberViolation) {
      violations.push(phoneNumberViolation);
    }
    markRuleEngineDetectStage(profile, 'phone-numbers');

    violations.push(
      ...this.messageLimitsDetector.detectAttachmentLimits({
        settings,
        hasPhotoAttachment,
        hasVideoAttachment,
        hasFileAttachment,
        hasVoiceAttachment,
        hasForwardedMessage,
      }),
    );
    markRuleEngineDetectStage(profile, 'attachments');

    const trafficEligible = !hasCompetingModerationViolation(violations);
    if (
      trafficEligible &&
      (settings.slowModeEnabled ||
        settings.mediaMessageCooldownEnabled ||
        settings.stickerMessagesEnabled === false)
    ) {
      try {
        const trafficViolation = await this.trafficProtectionDetector.detect({
          chatId,
          userId,
          messageId,
          eventType: duplicateStateEventType,
          eventTimestampMs: duplicateStateEventTimestampMs,
          mediaGroupId: params.mediaGroupId,
          text,
          settings,
          media: {
            hasPhotoAttachment,
            hasStickerAttachment,
            hasVideoAttachment,
            hasFileAttachment,
            hasVoiceAttachment,
            hasMediaBatch,
          },
        });
        if (trafficViolation) violations.push(trafficViolation);
      } catch {
        void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
          stage: 'rule-engine.traffic-protection',
          outcome: 'skip',
          failOpen: true,
        });
      }
    }
    markRuleEngineDetectStage(profile, 'traffic-protection');

    const hasTransferableAttachment = Boolean(
      hasPhotoAttachment ||
      hasVideoAttachment ||
      hasFileAttachment ||
      hasVoiceAttachment ||
      hasMediaBatch ||
      hasForwardedMessage,
    );
    const duplicateTextCandidate =
      settings.antiDuplicateEnabled &&
      violations.length === 0 &&
      !linkViolation &&
      !hasTransferableAttachment &&
      this.shouldTrackDuplicate(text, detectionContext.compactText, navigationTargets);
    const editedDuplicateStateCandidate =
      settings.antiDuplicateEnabled &&
      duplicateStateEventType === 'message_edited' &&
      Boolean(messageId);
    const duplicateCandidate = duplicateTextCandidate || editedDuplicateStateCandidate;
    const hasUsableDuplicateRevision =
      !messageId ||
      (Number.isSafeInteger(duplicateStateEventTimestampMs) &&
        (duplicateStateEventTimestampMs ?? 0) > 0);
    markRuleEngineDetectStage(profile, 'duplicate-precheck');
    const duplicateState =
      duplicateCandidate &&
      !skipDuplicateState &&
      (!skipStatefulMessageLimits || duplicateStateEventType === 'message_edited') &&
      hasUsableDuplicateRevision
        ? await this.duplicateDetector.detectWithin({
            chatId,
            userId,
            messageId,
            eventTimestampMs: duplicateStateEventTimestampMs,
            rawText: text,
            compactText: detectionContext.compactText,
            settings,
            navigationTargets,
            trackCurrentText: duplicateTextCandidate,
          })
        : undefined;
    markRuleEngineDetectStage(profile, 'duplicate-state');

    if (
      !hasCompetingModerationViolation(violations) &&
      !duplicateState?.hit &&
      !duplicateState?.decision &&
      !skipStatefulMessageLimits
    ) {
      violations.push(
        ...(await this.messageLimitsDetector.detectMediaCooldownLimits({
          chatId,
          userId,
          messageId,
          eventTimestampMs: duplicateStateEventTimestampMs,
          settings,
          hasPhotoAttachment,
          hasStickerAttachment,
        })),
      );
    }

    logSlowRuleEngineDetectIfNeeded({
      chatId,
      userId,
      measuredLength: detectionContext.measuredLength,
      settings,
      violationsCount: violations.length,
      duplicateCandidate,
      profile,
    });
    recordRuleEngineDetectProfile(profile, this.runtimeDiagnosticsService);

    return {
      violations,
      ...(duplicateState?.hit ? { duplicateHit: duplicateState.hit } : {}),
      ...(duplicateState?.decision ? { duplicateDecision: duplicateState.decision } : {}),
      ...(skipDuplicateState ? { duplicateStateSkipped: true } : {}),
    };
  }

  hasCommercialSpamMarkers(text: string): boolean {
    return this.commercialAdDetector.hasCommercialSpamMarkers(text);
  }

  detectProfanityForSettings(
    text: string,
    settings: Pick<ChatSettings, 'russianProfanityFilterEnabled' | 'profanitySensitivity'>,
  ): ProfanityDetectionDecision | null {
    if (!settings.russianProfanityFilterEnabled) return null;
    const rolloutMode = resolveProfanityRolloutMode();
    return this.detectProfanity(
      text,
      rolloutMode === 'legacy' ? 'STRICT' : resolveProfanitySensitivity(settings),
      rolloutMode,
    );
  }

  private detectProfanity(
    text: string,
    sensitivity: ProfanitySensitivity,
    rolloutMode: ProfanityRolloutMode = 'on',
  ): ProfanityDetectionDecision | null {
    const source = prepareProfanitySource(this.normalizeProfanityUnicode(text));
    const candidates = this.extractProfanityCandidates(source);
    let strongestDecision: ProfanityDetectionDecision | null = null;
    for (const candidate of candidates) {
      if (isLiteralLatinProfanityException(candidate)) continue;
      for (const normalizedCandidate of this.buildProfanityCyrillicCandidates(candidate.value)) {
        if (!normalizedCandidate || this.isProfanityException(normalizedCandidate)) {
          continue;
        }

        const coreFamilyId = this.resolveProfanityCoreFamily(
          normalizedCandidate,
          PROFANITY_CORE_TOKEN_PATTERNS,
        );
        const exactFamilyId = resolveExactProfanityVariantFamily(normalizedCandidate);
        const targetedFamilyId = resolveTargetedInsultVariantFamily(normalizedCandidate);
        if (!coreFamilyId && !exactFamilyId && !targetedFamilyId) continue;
        if (normalizedCandidate === 'ебу' && isEmbeddedShortProfanityFragment(source, candidate))
          continue;
        const normalizedContext = getProfanityCandidateContext(
          source,
          candidate,
          normalizedCandidate,
          (value) => this.normalizeProfanityTargetContext(value),
        );
        if (
          this.isContextualProfanityException(normalizedCandidate, normalizedContext) ||
          this.matchesWoodworkingContextException(normalizedCandidate, normalizedContext) ||
          this.matchesJoinedNotationException(normalizedCandidate, normalizedContext, candidate) ||
          this.matchesProperNameCapitalizationException(
            normalizedCandidate,
            normalizedContext,
            source,
            candidate,
          ) ||
          this.matchesUppercaseCodeProfanityException(
            normalizedCandidate,
            normalizedContext,
            candidate,
          ) ||
          this.matchesNumericNotationProfanityException(
            normalizedCandidate,
            normalizedContext,
            candidate,
            source,
          ) ||
          this.matchesMeasurementLiteralException(normalizedCandidate, source, candidate) ||
          this.matchesSelfDirectedMildInsultException(
            normalizedCandidate,
            normalizedContext,
            candidate,
          )
        ) {
          continue;
        }

        if (coreFamilyId) {
          return this.buildProfanityDecision({
            candidate,
            sensitivity,
            rolloutMode,
            familyId: coreFamilyId,
            matchKind: 'CORE_PATTERN',
            matchedVariant: normalizedCandidate,
            targetContext: this.hasExplicitProfanityTargetContext(
              normalizedCandidate,
              normalizedContext,
              candidate,
            ),
          });
        }

        if (exactFamilyId) {
          const decision = this.buildProfanityDecision({
            candidate,
            sensitivity,
            rolloutMode,
            familyId: exactFamilyId,
            matchKind: 'EXACT_VARIANT',
            matchedVariant: normalizedCandidate,
            targetContext: this.hasExplicitProfanityTargetContext(
              normalizedCandidate,
              normalizedContext,
              candidate,
            ),
          });
          if (decision) {
            strongestDecision = this.selectStrongerProfanityDecision(strongestDecision, decision);
          }
        }

        if (targetedFamilyId) {
          const category = classifyProfanityVariant(normalizedCandidate, 'TARGETED_VARIANT');
          const targetContext =
            rolloutMode === 'legacy'
              ? this.matchesTargetedInsultContext(normalizedCandidate, normalizedContext, candidate)
              : category === 'MILD_INSULT'
                ? this.hasExplicitProfanityTargetContext(
                    normalizedCandidate,
                    normalizedContext,
                    candidate,
                  )
                : this.matchesTargetedInsultContext(
                    normalizedCandidate,
                    normalizedContext,
                    candidate,
                  );
          if (targetContext) {
            const decision = this.buildProfanityDecision({
              candidate,
              sensitivity,
              rolloutMode,
              familyId: targetedFamilyId,
              matchKind: 'TARGETED_VARIANT',
              matchedVariant: normalizedCandidate,
              targetContext: true,
            });
            if (decision) {
              strongestDecision = this.selectStrongerProfanityDecision(strongestDecision, decision);
            }
          }
        }
      }

      for (const normalizedLatinCandidate of this.buildProfanityLatinCandidates(candidate.value)) {
        const latinCoreFamilyId = this.resolveProfanityCoreFamily(
          normalizedLatinCandidate,
          PROFANITY_LATIN_TOKEN_PATTERNS,
        );
        const latinTargetedFamilyId = resolveTargetedInsultVariantFamily(normalizedLatinCandidate);
        if (!latinCoreFamilyId && !latinTargetedFamilyId) continue;
        if (
          normalizedLatinCandidate === 'ebu' &&
          isEmbeddedShortProfanityFragment(source, candidate)
        )
          continue;
        const normalizedContext = getProfanityCandidateContext(
          source,
          candidate,
          normalizedLatinCandidate,
          (value) => this.normalizeProfanityTargetContext(value),
        );
        if (
          normalizedLatinCandidate &&
          this.matchesNumericNotationProfanityException(
            normalizedLatinCandidate,
            normalizedContext,
            candidate,
            source,
          )
        ) {
          continue;
        }

        if (
          !normalizedLatinCandidate ||
          this.matchesMeasurementLiteralException(normalizedLatinCandidate, source, candidate)
        ) {
          continue;
        }

        if (latinCoreFamilyId) {
          return this.buildProfanityDecision({
            candidate,
            sensitivity,
            rolloutMode,
            familyId: latinCoreFamilyId,
            matchKind: 'CORE_PATTERN',
            matchedVariant: normalizedLatinCandidate,
            targetContext: this.hasExplicitProfanityTargetContext(
              normalizedLatinCandidate,
              normalizedContext,
              candidate,
            ),
          });
        }

        if (latinTargetedFamilyId) {
          const category = classifyProfanityVariant(normalizedLatinCandidate, 'TARGETED_VARIANT');
          const targetContext =
            rolloutMode === 'legacy'
              ? this.matchesTargetedInsultContext(
                  normalizedLatinCandidate,
                  normalizedContext,
                  candidate,
                )
              : category === 'MILD_INSULT'
                ? this.hasExplicitProfanityTargetContext(
                    normalizedLatinCandidate,
                    normalizedContext,
                    candidate,
                  )
                : this.matchesTargetedInsultContext(
                    normalizedLatinCandidate,
                    normalizedContext,
                    candidate,
                  );
          if (targetContext) {
            const decision = this.buildProfanityDecision({
              candidate,
              sensitivity,
              rolloutMode,
              familyId: latinTargetedFamilyId,
              matchKind: 'TARGETED_VARIANT',
              matchedVariant: normalizedLatinCandidate,
              targetContext: true,
            });
            if (decision) {
              strongestDecision = this.selectStrongerProfanityDecision(strongestDecision, decision);
            }
          }
        }
      }
    }

    return strongestDecision;
  }

  private selectStrongerProfanityDecision(
    current: ProfanityDetectionDecision | null,
    candidate: ProfanityDetectionDecision,
  ): ProfanityDetectionDecision {
    return !current || candidate.score > current.score ? candidate : current;
  }

  private resolveProfanityCoreFamily(
    token: string,
    patterns: readonly ProfanityCorePattern[],
  ): string | null {
    if (!token) {
      return null;
    }

    return patterns.find(({ pattern }) => pattern.test(token))?.familyId ?? null;
  }

  private buildProfanityDecision(params: {
    candidate: ProfanityCandidate;
    sensitivity: ProfanitySensitivity;
    rolloutMode: ProfanityRolloutMode;
    familyId: string;
    matchKind: ProfanityMatchKind;
    matchedVariant: string;
    targetContext: boolean;
  }): ProfanityDetectionDecision | null {
    const category = classifyProfanityVariant(params.matchedVariant, params.matchKind);
    if (category === 'MILD_INSULT' && params.rolloutMode !== 'legacy' && !params.targetContext) {
      return null;
    }
    if (
      !isProfanityCategoryEnabled(category, params.sensitivity, params.rolloutMode, params.familyId)
    ) {
      return null;
    }

    return createProfanityDecision({
      category,
      sensitivity: params.sensitivity,
      rolloutMode: params.rolloutMode,
      familyId: params.familyId,
      matchKind: params.matchKind,
      matchedVariant: params.matchedVariant,
      evidence: this.buildProfanityEvidence(
        params.candidate,
        params.matchedVariant,
        params.targetContext,
      ),
    });
  }

  private buildProfanityEvidence(
    candidate: ProfanityCandidate,
    matchedVariant: string,
    targetContext: boolean,
  ): ProfanityEvidence[] {
    const evidence = new Set<ProfanityEvidence>();
    const rawValue = candidate.rawValue ?? candidate.value;

    if (candidate.joined) {
      evidence.add('JOINED_FRAGMENTS');
    }
    if (/[а-яё]/iu.test(rawValue) && /[a-z]/iu.test(rawValue)) {
      evidence.add('MIXED_SCRIPT');
    }

    const innerValue = rawValue.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (/[^\p{L}\p{N}]/u.test(innerValue) || /[0-9@!|$€₽¥]/u.test(rawValue)) {
      evidence.add('CHAR_SUBSTITUTION');
    }
    if (/[a-z]/iu.test(matchedVariant) && !/[а-яё]/iu.test(matchedVariant)) {
      evidence.add('LATIN_TRANSLITERATION');
    }
    if (targetContext) {
      evidence.add('TARGET_CONTEXT');
    }
    if (
      /([a-zа-яё])\1/iu.test(rawValue) &&
      this.normalizeProfanityCandidate(rawValue) !== matchedVariant &&
      this.normalizeProfanityLatinCandidate(rawValue) !== matchedVariant
    ) {
      evidence.add('REPEATED_LETTERS');
    }
    if (evidence.size === 0) {
      evidence.add('TOKEN');
    }

    return [...evidence];
  }

  private hasExplicitProfanityTargetContext(
    token: string,
    normalizedContext: string,
    candidate: ProfanityCandidate,
  ): boolean {
    return this.matchesTargetedInsultContext(token, normalizedContext, {
      ...candidate,
      joined: false,
    });
  }

  private isProfanityException(token: string): boolean {
    return PROFANITY_EXCEPTIONS.some((exception) => token.startsWith(exception));
  }

  private matchesMeasurementLiteralException(
    token: string,
    source: string,
    candidate: ProfanityCandidate,
  ): boolean {
    const context = getMeasurementLiteralContext(source, candidate, token);
    if (context?.unambiguousUnit) return true;
    return Boolean(
      context &&
      !this.hasExplicitProfanityTargetContext(
        this.normalizeForDetection(token),
        this.normalizeForDetection(context.text),
        candidate,
      ) &&
      !this.hasExplicitProfanityTargetContext(
        token,
        this.normalizeProfanityTargetContext(context.text),
        candidate,
      ),
    );
  }

  private matchesWoodworkingContextException(token: string, context: string): boolean {
    return (
      /^(?:сучки|сучков|сучкам|сучками|сучках|сучок)$/u.test(token) &&
      /(?:доск|древесин|деревян|пиломатериал|зашлиф|шлифов|вагонк|бревн|брёвен)/u.test(context) &&
      !this.hasUnsafeProfanityContextAroundToken(token, context)
    );
  }

  private isContextualProfanityException(token: string, normalizedContext: string): boolean {
    // FLAG: A neutral topic elsewhere never exempts a direct attack in this message.
    if (!normalizedContext || this.hasUnsafeProfanityContextAroundToken(token, normalizedContext)) {
      return false;
    }

    return (
      this.matchesProfanityReachTypoException(token, normalizedContext) ||
      this.matchesSafeListingContextException(
        token,
        normalizedContext,
        PROFANITY_CANINE_FEMALE_FORMS,
        PROFANITY_CANINE_LISTING_CONTEXT_MARKERS,
      ) ||
      this.matchesProfanityContextException(
        token,
        normalizedContext,
        PROFANITY_CANINE_FEMALE_FORMS,
        PROFANITY_CANINE_STRONG_CONTEXT_MARKERS,
        1,
      ) ||
      this.matchesProfanityContextException(
        token,
        normalizedContext,
        PROFANITY_CANINE_FEMALE_FORMS,
        PROFANITY_CANINE_CONTEXT_MARKERS,
      ) ||
      this.matchesProfanityContextException(
        token,
        normalizedContext,
        PROFANITY_LIVESTOCK_FORMS,
        PROFANITY_LIVESTOCK_STRONG_CONTEXT_MARKERS,
        1,
      ) ||
      this.matchesSafeListingContextException(
        token,
        normalizedContext,
        PROFANITY_LIVESTOCK_FORMS,
        PROFANITY_LIVESTOCK_LISTING_CONTEXT_MARKERS,
      ) ||
      this.matchesProfanityContextException(
        token,
        normalizedContext,
        PROFANITY_LIVESTOCK_FORMS,
        PROFANITY_LIVESTOCK_CONTEXT_MARKERS,
      ) ||
      this.matchesProfanityContextException(
        token,
        normalizedContext,
        PROFANITY_PARASITE_FORMS,
        PROFANITY_PARASITE_STRONG_CONTEXT_MARKERS,
        1,
      ) ||
      this.matchesProfanityContextException(
        token,
        normalizedContext,
        PROFANITY_PARASITE_FORMS,
        PROFANITY_PARASITE_CONTEXT_MARKERS,
      ) ||
      this.matchesProfanityContextException(
        token,
        normalizedContext,
        PROFANITY_GARDEN_PEST_FORMS,
        PROFANITY_GARDEN_PEST_STRONG_CONTEXT_MARKERS,
        1,
      ) ||
      this.matchesProfanityContextException(
        token,
        normalizedContext,
        PROFANITY_GARDEN_PEST_FORMS,
        PROFANITY_GARDEN_PEST_CONTEXT_MARKERS,
      ) ||
      this.matchesProfanityContextException(
        token,
        normalizedContext,
        PROFANITY_AXIS_DIMENSION_FORMS,
        PROFANITY_AXIS_DIMENSION_CONTEXT_MARKERS,
      ) ||
      this.matchesProfanityContextException(
        token,
        normalizedContext,
        PROFANITY_PROPER_NAME_FORMS,
        PROFANITY_PROPER_NAME_CONTEXT_MARKERS,
        1,
      ) ||
      this.matchesProfanityContextException(
        token,
        normalizedContext,
        PROFANITY_BOTANY_AND_PLACE_FORMS,
        PROFANITY_BOTANY_AND_PLACE_CONTEXT_MARKERS,
        1,
      ) ||
      this.matchesProfanityContextException(
        token,
        normalizedContext,
        PROFANITY_CLINICAL_FORMS,
        PROFANITY_CLINICAL_CONTEXT_MARKERS,
        1,
      ) ||
      this.matchesCompletionContextException(token, normalizedContext) ||
      this.matchesProfanityContextException(
        token,
        normalizedContext,
        PROFANITY_LITERARY_TITLE_FORMS,
        PROFANITY_LITERARY_TITLE_CONTEXT_MARKERS,
        1,
      ) ||
      this.matchesProfanityContextException(
        token,
        normalizedContext,
        PROFANITY_LATIN_CULTURAL_NAME_FORMS,
        PROFANITY_LATIN_CULTURAL_NAME_CONTEXT_MARKERS,
        1,
      ) ||
      this.matchesCyrillicCulturalNameException(token, normalizedContext)
    );
  }

  private matchesCyrillicCulturalNameException(token: string, normalizedContext: string): boolean {
    return (
      this.matchesProfanityContextException(
        token,
        normalizedContext,
        PROFANITY_CYRILLIC_CULTURAL_NAME_FORMS,
        PROFANITY_LATIN_CULTURAL_NAME_CONTEXT_MARKERS,
        2,
      ) && !this.hasUnsafeProfanityContextAroundToken(token, normalizedContext)
    );
  }

  private matchesSafeListingContextException(
    token: string,
    normalizedContext: string,
    forms: ReadonlySet<string>,
    markers: readonly string[],
  ): boolean {
    return (
      forms.has(token) &&
      !this.hasUnsafeProfanityContextAroundToken(token, normalizedContext) &&
      this.hasNormalizedContextMarker(normalizedContext, markers)
    );
  }

  private matchesCompletionContextException(token: string, normalizedContext: string): boolean {
    return (
      PROFANITY_COMPLETION_FORMS.has(token) &&
      !this.hasUnsafeProfanityContextAroundToken(token, normalizedContext) &&
      this.hasNormalizedContextMarker(normalizedContext, PROFANITY_COMPLETION_CONTEXT_MARKERS)
    );
  }

  private hasUnsafeProfanityContextAroundToken(token: string, normalizedContext: string): boolean {
    const tokens = tokenizeProfanityContext(normalizedContext, PROFANITY_DIRECT_ADDRESS_MARKERS);

    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index] !== token) {
        continue;
      }

      if (
        this.hasDirectAddressBeforeTarget(tokens, index) ||
        this.hasDirectAddressAfterTarget(tokens, index) ||
        this.hasDemonstrativeHostileTarget(tokens, index) ||
        this.hasHostileCommandAfterTarget(tokens, index)
      ) {
        return true;
      }
    }

    return false;
  }

  private hasDirectAddressAroundContextToken(token: string, normalizedContext: string): boolean {
    const tokens = tokenizeProfanityContext(normalizedContext, PROFANITY_DIRECT_ADDRESS_MARKERS);

    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index] !== token) {
        continue;
      }

      if (
        this.hasDirectAddressBeforeTarget(tokens, index) ||
        this.hasDirectAddressAfterTarget(tokens, index)
      ) {
        return true;
      }
    }

    return false;
  }

  private matchesProfanityContextException(
    token: string,
    normalizedContext: string,
    forms: ReadonlySet<string>,
    markers: readonly string[],
    minimumMatchedMarkers = 2,
  ): boolean {
    if (!forms.has(token)) {
      return false;
    }

    let matchedMarkers = 0;
    for (const marker of markers) {
      if (!normalizedContext.includes(marker)) {
        continue;
      }

      matchedMarkers += 1;
      if (matchedMarkers >= minimumMatchedMarkers) {
        return true;
      }
    }

    return false;
  }

  private matchesProfanityReachTypoException(token: string, normalizedContext: string): boolean {
    if (
      token !== 'суки' ||
      !/(?:^|[^\p{L}\p{N}_-])за\s+суки(?=$|[^\p{L}\p{N}_-])/u.test(normalizedContext)
    ) {
      return false;
    }

    let matchedMarkers = 0;
    for (const marker of PROFANITY_REACH_TYPO_CONTEXT_MARKERS) {
      if (!normalizedContext.includes(marker)) {
        continue;
      }

      matchedMarkers += 1;
      if (matchedMarkers >= 2) {
        return true;
      }
    }

    return false;
  }

  private matchesJoinedNotationException(
    token: string,
    normalizedContext: string,
    candidate: ProfanityCandidate,
  ): boolean {
    const isNotationLikeToken =
      token === 'бля' || token.startsWith('хуй') || token.startsWith('хуи');
    if (!candidate.joined || !isNotationLikeToken) {
      return false;
    }

    const hasNotationContext =
      normalizedContext.includes('инициал') ||
      normalizedContext.includes('маркировк') ||
      normalizedContext.includes('схем') ||
      normalizedContext.includes('анкете') ||
      normalizedContext.includes('код ');

    if (!hasNotationContext) {
      return false;
    }

    return !this.hasDirectProfanityAddressContext(normalizedContext);
  }

  private hasDirectProfanityAddressContext(normalizedContext: string): boolean {
    const tokens = tokenizeProfanityContext(normalizedContext, PROFANITY_DIRECT_ADDRESS_MARKERS);

    return tokens.some(
      (token) =>
        PROFANITY_DIRECT_ADDRESS_MARKERS.has(token) ||
        PROFANITY_HOSTILE_AFTER_TARGET_TOKENS.has(token),
    );
  }

  private matchesProperNameCapitalizationException(
    token: string,
    normalizedContext: string,
    rawText: string,
    candidate: ProfanityCandidate,
  ): boolean {
    if (
      candidate.joined ||
      candidate.rawIndex === undefined ||
      !PROFANITY_PROPER_NAME_FORMS.has(token)
    ) {
      return false;
    }

    const before = rawText.slice(0, candidate.rawIndex);
    const after = rawText.slice(candidate.rawIndex + (candidate.rawValue?.length ?? 0));
    const previousWord = before.match(/[\p{L}][\p{L}-]*\s*$/u)?.[0]?.trim() ?? '';
    const nextWord = after.match(/^\s*[\p{L}][\p{L}-]*/u)?.[0]?.trim() ?? '';

    if (this.isCapitalizedCyrillicName(previousWord) || this.isCapitalizedCyrillicName(nextWord)) {
      return true;
    }

    const rawValue = candidate.rawValue ?? '';
    return (
      this.isCapitalizedCyrillicName(rawValue) &&
      !this.hasDirectAddressAroundContextToken(token, normalizedContext) &&
      this.hasNormalizedContextMarker(
        normalizedContext,
        PROFANITY_PROPER_NAME_STANDALONE_CONTEXT_MARKERS,
      )
    );
  }

  private matchesUppercaseCodeProfanityException(
    token: string,
    normalizedContext: string,
    candidate: ProfanityCandidate,
  ): boolean {
    const rawValue = candidate.rawValue ?? '';
    return (
      !candidate.joined &&
      token === 'пздц' &&
      /^[A-ZА-ЯЁІЇЄҐ]{3,6}$/u.test(rawValue) &&
      !this.hasUnsafeProfanityContextAroundToken(token, normalizedContext) &&
      this.hasNormalizedContextMarker(normalizedContext, PROFANITY_CODE_CONTEXT_MARKERS)
    );
  }

  private matchesNumericNotationProfanityException(
    token: string,
    normalizedContext: string,
    candidate: ProfanityCandidate,
    rawText: string,
  ): boolean {
    if (
      !/^(?:еб[а-я0-9]*|eb[a-z0-9]*)$/iu.test(token) ||
      this.hasDirectProfanityAddressContext(normalizedContext)
    ) {
      return false;
    }

    if (
      this.isSizeRangeProfanityCandidate(candidate) &&
      (this.hasSizeRangeContext(normalizedContext, rawText) ||
        this.isOnlySizeRangeNotation(rawText))
    ) {
      return true;
    }

    return (
      this.isHorsepowerProfanityCandidate(candidate) &&
      PROFANITY_HORSEPOWER_NOTATION_PATTERN.test(rawText) &&
      this.hasNormalizedContextMarker(normalizedContext, PROFANITY_HORSEPOWER_CONTEXT_MARKERS)
    );
  }

  private isSizeRangeProfanityCandidate(candidate: ProfanityCandidate): boolean {
    const rawValue = (candidate.rawValue ?? candidate.value).replace(/\s+/gu, '');
    return (
      /(?:^|[^\p{L}\p{N}])(?:р\.?\s*)?(?:2[0-9]|3[0-9]|4[0-9]|5[0-2])\s*[/-]\s*(?:2[0-9]|3[0-9]|4[0-9]|5[0-2])\s*(?:р\.?|разм(?:ер)?\.?)?(?=$|[^\p{L}\p{N}])/iu.test(
        rawValue,
      ) ||
      (candidate.joined && /^\d{2,4}et$/iu.test(rawValue)) ||
      (candidate.joined &&
        /^(?:р)?(?:2[0-9]|3[0-9]|4[0-9]|5[0-2])(?:2[0-9]|3[0-9]|4[0-9]|5[0-2])(?:за)?$/iu.test(
          rawValue,
        ))
    );
  }

  private hasSizeRangeContext(normalizedContext: string, rawText: string): boolean {
    return (
      PROFANITY_SIZE_RANGE_NOTATION_PATTERN.test(rawText) &&
      this.hasNormalizedContextMarker(normalizedContext, PROFANITY_SIZE_NOTATION_CONTEXT_MARKERS)
    );
  }

  private isOnlySizeRangeNotation(rawText: string): boolean {
    const trimmed = rawText.trim();
    return trimmed.length <= 16 && PROFANITY_SIZE_RANGE_NOTATION_PATTERN.test(trimmed);
  }

  private isHorsepowerProfanityCandidate(candidate: ProfanityCandidate): boolean {
    const rawValue = (candidate.rawValue ?? candidate.value).replace(
      /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu,
      '',
    );
    return (
      (candidate.joined && /^\d{1,4}(?:л|лс)$/iu.test(rawValue.replace(/[\s.]+/gu, ''))) ||
      /^\d{1,3}(?:[,.]\d{1,2})?\s*(?:л\.?\s*с\.?|лс)$/iu.test(rawValue)
    );
  }

  private hasNormalizedContextMarker(
    normalizedContext: string,
    markers: readonly string[],
  ): boolean {
    return markers.some((marker) => normalizedContext.includes(marker));
  }

  private matchesSelfDirectedMildInsultException(
    token: string,
    normalizedContext: string,
    candidate: ProfanityCandidate,
  ): boolean {
    if (
      candidate.joined ||
      !PROFANITY_SELF_DIRECTED_MILD_INSULT_FORMS.has(token) ||
      this.hasDirectProfanityAddressContext(normalizedContext)
    ) {
      return false;
    }

    const tokens = normalizedContext
      .replace(/[^\p{L}\p{N}-]+/gu, ' ')
      .split(/\s+/u)
      .filter(Boolean);

    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index] !== token) {
        continue;
      }

      if (this.hasSelfReferenceBeforeTarget(tokens, index)) {
        return true;
      }
    }

    return false;
  }

  private hasSelfReferenceBeforeTarget(tokens: readonly string[], targetIndex: number): boolean {
    for (let index = targetIndex - 1; index >= Math.max(0, targetIndex - 4); index -= 1) {
      const token = tokens[index];
      if (!token) {
        continue;
      }

      if (PROFANITY_SELF_REFERENCE_MARKERS.has(token)) {
        return true;
      }

      if (!PROFANITY_SELF_REFERENCE_BRIDGE_TOKENS.has(token)) {
        return false;
      }
    }

    return false;
  }

  private isCapitalizedCyrillicName(value: string): boolean {
    return /^[А-ЯЁ][а-яё]{1,}(?:-[А-ЯЁ][а-яё]{1,})?$/u.test(value);
  }

  private matchesTargetedInsultContext(
    token: string,
    normalizedContext: string,
    candidate: ProfanityCandidate,
  ): boolean {
    if (candidate.joined && classifyProfanityVariant(token, 'TARGETED_VARIANT') === 'MILD_INSULT') {
      return true;
    }

    const tokens = tokenizeProfanityContext(normalizedContext, PROFANITY_DIRECT_ADDRESS_MARKERS);
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index] !== token) {
        continue;
      }

      if (this.isNeutralTargetedModifier(tokens, index, token)) {
        continue;
      }

      if (
        this.hasDirectAddressBeforeTarget(tokens, index) ||
        this.hasDirectAddressAfterTarget(tokens, index) ||
        this.hasDemonstrativeHostileTarget(tokens, index) ||
        this.hasThirdPersonInsultTarget(tokens, index, token) ||
        this.hasHostileCommandAfterTarget(tokens, index)
      ) {
        return true;
      }
    }

    return false;
  }

  private isNeutralTargetedModifier(
    tokens: readonly string[],
    targetIndex: number,
    token: string,
  ): boolean {
    if (!PROFANITY_NEUTRAL_MODIFIER_FORMS.has(token)) {
      return false;
    }

    const next = tokens[targetIndex + 1];
    return Boolean(next && PROFANITY_NEUTRAL_MODIFIER_NOUNS.has(next));
  }

  private hasDirectAddressBeforeTarget(tokens: readonly string[], targetIndex: number): boolean {
    for (let index = targetIndex - 1; index >= Math.max(0, targetIndex - 5); index -= 1) {
      const token = tokens[index];
      if (!token) {
        continue;
      }

      if (PROFANITY_DIRECT_ADDRESS_MARKERS.has(token)) {
        return true;
      }

      if (!PROFANITY_TARGET_BRIDGE_TOKENS.has(token)) {
        return false;
      }
    }

    return false;
  }

  private hasDirectAddressAfterTarget(tokens: readonly string[], targetIndex: number): boolean {
    for (
      let index = targetIndex + 1;
      index <= Math.min(tokens.length - 1, targetIndex + 4);
      index += 1
    ) {
      const token = tokens[index];
      if (!token) {
        continue;
      }

      if (PROFANITY_DIRECT_ADDRESS_MARKERS.has(token)) {
        return true;
      }

      if (!PROFANITY_TARGET_BRIDGE_TOKENS.has(token)) {
        return false;
      }
    }

    return false;
  }

  private hasDemonstrativeHostileTarget(tokens: readonly string[], targetIndex: number): boolean {
    const previous = tokens[targetIndex - 1];
    if (!previous || !PROFANITY_DEMONSTRATIVE_TARGET_MARKERS.has(previous)) {
      return false;
    }

    for (
      let index = targetIndex + 1;
      index <= Math.min(tokens.length - 1, targetIndex + 3);
      index += 1
    ) {
      const token = tokens[index];
      if (token && /^[.!?;\r\n\0]+$/u.test(token)) return false;
      if (
        token &&
        PROFANITY_HOSTILE_AFTER_TARGET_TOKENS.has(token) &&
        !(
          PROFANITY_NEUTRAL_PREDICATES.has(token) &&
          /^(?:аутист|наркоман|алкогол)/u.test(tokens[targetIndex] ?? '')
        )
      ) {
        return true;
      }
    }

    return false;
  }

  private hasThirdPersonInsultTarget(
    tokens: readonly string[],
    targetIndex: number,
    token: string,
  ): boolean {
    if (PROFANITY_NEUTRAL_IDENTITY_FORMS.has(token)) {
      return false;
    }

    let sawTargetMarker = false;
    for (let index = targetIndex - 1; index >= Math.max(0, targetIndex - 4); index -= 1) {
      const current = tokens[index];
      if (!current) {
        continue;
      }

      if (PROFANITY_THIRD_PERSON_SAFE_TOKENS.has(current)) {
        return false;
      }

      if (PROFANITY_THIRD_PERSON_TARGET_MARKERS.has(current)) {
        sawTargetMarker = true;
        continue;
      }

      if (!PROFANITY_TARGET_BRIDGE_TOKENS.has(current)) {
        break;
      }
    }

    return sawTargetMarker;
  }

  private hasHostileCommandAfterTarget(tokens: readonly string[], targetIndex: number): boolean {
    for (
      let index = targetIndex + 1;
      index <= Math.min(tokens.length - 1, targetIndex + 3);
      index += 1
    ) {
      const token = tokens[index];
      if (!token) {
        continue;
      }

      if (
        PROFANITY_HOSTILE_AFTER_TARGET_TOKENS.has(token) &&
        !PROFANITY_NEUTRAL_PREDICATES.has(token)
      ) {
        return true;
      }

      if (!PROFANITY_TARGET_BRIDGE_TOKENS.has(token)) {
        return false;
      }
    }

    return false;
  }

  private shouldTrackDuplicate(
    rawText: string,
    compactText: string,
    navigationTargets?: readonly NavigationTargetEvidence[],
  ): boolean {
    if (this.isDuplicateServiceCommand(rawText)) {
      return false;
    }

    const hasNavigationTarget = (navigationTargets ?? []).some(isEnforceableLinkPolicyTarget);
    const signalCharacters = (compactText.match(/[\p{L}\p{N}]/gu) ?? []).length;
    if (signalCharacters < DUPLICATE_EXACT_MIN_SIGNAL_CHARACTERS && !hasNavigationTarget) {
      return false;
    }
    if (
      hasNavigationTarget ||
      extractUrlsFromText(rawText).length > 0 ||
      extractLegacyDuplicatePhoneNumbers(rawText).length > 0 ||
      rawText.trimStart().startsWith('/')
    ) {
      return true;
    }
    if (this.commercialAdDetector.hasCommercialSpamMarkers(compactText)) {
      return true;
    }

    const tokens = this.extractTokens(compactText);
    if (compactText.length < DUPLICATE_MIN_LENGTH || tokens.length < DUPLICATE_MIN_TOKEN_COUNT) {
      return false;
    }

    return (
      new Set(tokens.filter((token) => token.length >= 4)).size >= DUPLICATE_MIN_UNIQUE_LONG_TOKENS
    );
  }

  private isDuplicateServiceCommand(rawText: string): boolean {
    if (DUPLICATE_COMMAND_ONLY_PATTERN.test(rawText)) {
      return true;
    }
    const startWithPayload = DUPLICATE_START_WITH_PAYLOAD_PATTERN.exec(rawText);
    return isValidMaxBotStartPayload(startWithPayload?.[1]);
  }

  private normalizeForDetection(value: string): string {
    return normalizeForDetection(value);
  }

  private extractProfanityCandidates(value: string): ProfanityCandidate[] {
    if (!value) {
      return [];
    }

    // FLAG: Numeric lists are not letter fragments. Mask only complete multi-digit numbers;
    // preserve offsets, mixed alphanumeric tokens, and single-digit leetspeak for detection.
    const rawStripped = value.replace(PROFANITY_NUMERIC_LIST_PATTERN, (match) =>
      '\0'.repeat(match.length),
    );
    const stripped = rawStripped.toLowerCase();
    const whitespaceSegments = [...rawStripped.matchAll(/[^\s\0]+/gu)];
    const candidates: ProfanityCandidate[] = [];
    const seenCandidates = new Set<string>();
    const pushCandidate = (candidate: ProfanityCandidate) => {
      const key = `${candidate.joined ? '1' : '0'}:${candidate.rawIndex}:${candidate.value}`;
      if (seenCandidates.has(key)) {
        return;
      }

      seenCandidates.add(key);
      candidates.push(candidate);
    };

    // FLAG: Keep independent words alongside obfuscated whole tokens, so protecting a literal
    // span cannot hide neighboring profanity attached with punctuation and no whitespace.
    const wordSegments = rawStripped.matchAll(/[\p{L}\p{N}@!|$€₽¥]+/gu);
    for (const match of [...wordSegments, ...whitespaceSegments]) {
      const rawSegment = match[0];
      pushCandidate({
        value: rawSegment.toLowerCase(),
        joined: false,
        rawValue: rawSegment,
        rawIndex: match.index,
        rawEnd: match.index + rawSegment.length,
      });
    }

    const joinSegments = [...stripped.matchAll(/[\p{L}\p{N}@!|$]+|[^\s\p{L}\p{N}]+/gu)];

    for (let index = 0; index < joinSegments.length; index += 1) {
      let joinedCandidate = '';
      let joinedCount = 0;
      let noiseCount = 0;

      for (
        let cursor = index;
        cursor < joinSegments.length && cursor < index + PROFANITY_JOIN_WINDOW_SEGMENTS;
        cursor += 1
      ) {
        const segment = joinSegments[cursor]?.[0] ?? '';
        const normalizedToken = this.normalizeProfanityJoinToken(segment);
        if (normalizedToken) {
          joinedCandidate += normalizedToken;
          joinedCount += 1;
          if (joinedCount >= 2) {
            const rawIndex = joinSegments[index]!.index;
            const rawEnd = joinSegments[cursor]!.index + segment.length;
            pushCandidate({
              value: joinedCandidate,
              joined: true,
              rawValue: rawStripped.slice(rawIndex, rawEnd),
              rawIndex,
              rawEnd,
            });
          }
          if (joinedCount >= PROFANITY_JOIN_MAX_FRAGMENTS) {
            break;
          }
          continue;
        }

        if (joinedCount === 0 || !this.isProfanityJoinNoiseSegment(segment)) {
          break;
        }

        noiseCount += Array.from(segment).length;
        if (noiseCount > PROFANITY_JOIN_NOISE_BUDGET) {
          break;
        }
      }
    }

    // FLAG: A verified literal must not become profanity again when a longer candidate
    // joins it to a preposition or the next clause. Independent words retain their own spans.
    const literalSpans = candidates.filter(
      (candidate) =>
        isLiteralLatinProfanityException(candidate) ||
        this.matchesMeasurementLiteralException(candidate.value, value, candidate),
    );
    return excludeProtectedProfanitySpans(candidates, literalSpans);
  }

  private normalizeProfanityCandidate(value: string): string {
    if (!value) {
      return '';
    }

    let normalized = this.normalizeProfanityUnicode(value.toLowerCase());
    normalized = this.normalizeMixedWritingForProfanity(normalized);
    normalized = normalized.replace(/ё/g, 'е');
    normalized = normalized.replace(/([a-zа-я0-9])\1{2,}/giu, '$1$1');
    normalized = normalized.replace(/[_*~`"'«»“”(){}[[]\]|]+/g, '');
    normalized = normalized.replace(/[^\p{L}\p{N}]+/gu, '');
    return normalized;
  }

  private buildProfanityCyrillicCandidates(value: string): string[] {
    if (!value) {
      return [];
    }

    const candidates = new Set<string>();
    const normalized = this.normalizeProfanityCandidate(value);
    if (normalized) {
      candidates.add(normalized);
    }

    if (this.shouldBuildAmbiguousProfanityCandidate(value)) {
      const primaryMapped = this.normalizeProfanityCandidateWithMap(value, MIXED_CHAR_MAP);
      if (primaryMapped) {
        candidates.add(primaryMapped);
      }

      const ambiguous = this.normalizeProfanityCandidateWithMap(
        value,
        PROFANITY_AMBIGUOUS_MIXED_CHAR_MAP,
      );
      if (ambiguous) {
        candidates.add(ambiguous);
      }

      const phonetic = this.normalizeProfanityCandidateWithMap(
        value,
        PROFANITY_PHONETIC_MIXED_CHAR_MAP,
      );
      if (phonetic) {
        candidates.add(phonetic);
      }

      const leet = this.normalizeProfanityCandidateWithMap(value, PROFANITY_LEET_MIXED_CHAR_MAP);
      if (leet) {
        candidates.add(leet);
      }
    }

    return this.appendRepeatedProfanityCoreCandidates(candidates, PROFANITY_CORE_TOKEN_PATTERNS);
  }

  private appendRepeatedProfanityCoreCandidates(
    candidates: Set<string>,
    patterns: readonly ProfanityCorePattern[],
  ): string[] {
    // FLAG: Repetition folding only expands productive mat roots. Do not fuzzily expand
    // ambiguous insults or numbers; original candidates and their exceptions remain intact.
    for (const candidate of [...candidates]) {
      const collapsed = candidate.replace(/([a-zа-яё])\1+/gu, '$1');
      if (collapsed !== candidate && this.resolveProfanityCoreFamily(collapsed, patterns)) {
        candidates.add(collapsed);
      }
    }
    return [...candidates];
  }

  private shouldBuildAmbiguousProfanityCandidate(value: string): boolean {
    return /[а-яёіїєґ@!|€₽¥]/iu.test(value) && /[a-z0-9@!|€₽¥]/iu.test(value);
  }

  private normalizeProfanityCandidateWithMap(
    value: string,
    charMap: Readonly<Record<string, string>>,
  ): string {
    if (!value) {
      return '';
    }

    let normalized = '';
    for (const char of this.normalizeProfanityUnicode(value.toLowerCase())) {
      const mapped = charMap[char] ?? char;
      if (/[\p{L}\p{N}]/u.test(mapped)) {
        normalized += mapped;
      }
    }

    normalized = normalized.replace(/ё/g, 'е');
    normalized = normalized.replace(/([a-zа-я0-9])\1{2,}/giu, '$1$1');
    return normalized;
  }

  private normalizeProfanityLatinCandidate(value: string): string {
    if (!value) {
      return '';
    }

    let normalized = this.normalizeProfanityUnicode(value.toLowerCase());
    normalized = normalized.replace(/([a-z0-9])\1{2,}/g, '$1$1');
    normalized = normalized.replace(/[^a-z0-9]+/g, '');
    return normalized;
  }

  private normalizeProfanityTargetContext(value: string): string {
    if (!value) {
      return '';
    }

    let normalized = this.normalizeProfanityUnicode(value.toLowerCase());
    normalized = normalized.replace(/([a-z0-9])\1{2,}/g, '$1$1');
    normalized = normalized.replace(/ё/g, 'е');
    normalized = normalized.replace(/[^а-яa-z0-9.!?;\r\n\0-]+/g, ' ');
    normalized = normalized.replace(/\s+/g, ' ').trim();
    return normalized;
  }

  private buildProfanityLatinCandidates(value: string): string[] {
    if (!value || !this.shouldBuildLatinProfanityCandidate(value)) {
      return [];
    }

    const candidates = new Set<string>();
    const normalized = this.normalizeProfanityLatinCandidate(value);
    if (normalized) {
      candidates.add(normalized);
    }

    if (this.shouldBuildLatinLeetProfanityCandidate(value)) {
      const leetNormalized = this.normalizeProfanityLatinLeetCandidate(value);
      if (leetNormalized) {
        candidates.add(leetNormalized);
      }
    }

    return this.appendRepeatedProfanityCoreCandidates(candidates, PROFANITY_LATIN_TOKEN_PATTERNS);
  }

  private shouldBuildLatinProfanityCandidate(value: string): boolean {
    return /[a-z]/i.test(value);
  }

  private shouldBuildLatinLeetProfanityCandidate(value: string): boolean {
    return /[a-z]/i.test(value) && /[013456789@!|$]/.test(value);
  }

  private normalizeProfanityLatinLeetCandidate(value: string): string {
    if (!value) {
      return '';
    }

    let normalized = '';
    for (const char of this.normalizeProfanityUnicode(value.toLowerCase())) {
      const mapped = PROFANITY_LATIN_LEET_CHAR_MAP[char] ?? char;
      if (/[a-z0-9]/i.test(mapped)) {
        normalized += mapped;
      }
    }

    normalized = normalized.replace(/([a-z0-9])\1{2,}/g, '$1$1');
    return normalized;
  }

  private normalizeProfanityJoinToken(value: string): string {
    if (!/[a-zа-яё0-9]/iu.test(value)) {
      const symbolLeetNormalized = this.normalizeProfanityLatinLeetCandidate(value);
      return this.isLatinProfanityJoinToken(symbolLeetNormalized) ? symbolLeetNormalized : '';
    }

    for (const normalized of this.buildProfanityCyrillicCandidates(value)) {
      if (this.isCyrillicProfanityJoinToken(normalized)) {
        return normalized;
      }
    }

    const latinNormalized = this.normalizeProfanityLatinLeetCandidate(value);
    return this.isLatinProfanityJoinToken(latinNormalized) ? latinNormalized : '';
  }

  private isCyrillicProfanityJoinToken(value: string): boolean {
    return (
      /^[а-яё0-9]+$/iu.test(value) &&
      (value.length <= 2 || PROFANITY_SHORT_JOINABLE_TOKENS.has(value))
    );
  }

  private isLatinProfanityJoinToken(value: string): boolean {
    return (
      /^[a-z0-9]+$/i.test(value) &&
      (value.length <= 2 || PROFANITY_LATIN_JOINABLE_TOKENS.has(value))
    );
  }

  private isProfanityJoinNoiseSegment(value: string): boolean {
    return value.length > 0 && !/[\p{L}\p{N}@!|$\0]/u.test(value);
  }

  private normalizeMixedWritingForProfanity(value: string): string {
    return value.replace(/[\p{L}\p{N}]+/gu, (token) => this.normalizeProfanityToken(token));
  }

  private normalizeProfanityToken(token: string): string {
    const lowered = this.normalizeProfanityUnicode(token.toLowerCase());
    const hasCyrillic = /[а-яё]/iu.test(lowered);
    const hasLatin = /[a-z]/iu.test(lowered);
    const hasLetter = /[\p{L}]/u.test(token);
    let result = '';

    for (const char of lowered) {
      if (!hasLetter && /\p{N}/u.test(char)) {
        result += char;
        continue;
      }

      if (!hasCyrillic && hasLatin && /[a-z]/iu.test(char)) {
        result += char;
        continue;
      }

      result += MIXED_CHAR_MAP[char] ?? PROFANITY_EXTRA_CHAR_MAP[char] ?? char;
    }

    return result;
  }

  private normalizeProfanityUnicode(value: string): string {
    if (!value) {
      return '';
    }

    return value
      .normalize('NFKC')
      .replace(/[\u0300-\u036f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '');
  }

  private normalizeMixedWriting(value: string): string {
    return normalizeMixedWriting(value);
  }

  private extractTokens(value: string): string[] {
    const normalized = this.normalizeForDetection(value);
    return normalized.match(/[a-zа-яё0-9]+/giu) ?? [];
  }
}
