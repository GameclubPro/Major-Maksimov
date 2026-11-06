export const PROFANITY_DETECTOR_VERSION = 'profanity-structured-v4';

export const PROFANITY_SENSITIVITIES = ['CORE_ONLY', 'BALANCED', 'STRICT'] as const;

export type ProfanitySensitivity = (typeof PROFANITY_SENSITIVITIES)[number];

export type ProfanityRolloutMode = 'on' | 'legacy';

export type ProfanityCategory = 'CORE_MAT' | 'SEVERE_ABUSE' | 'MILD_INSULT';

export type ProfanityMatchKind = 'CORE_PATTERN' | 'EXACT_VARIANT' | 'TARGETED_VARIANT';

export type ProfanityEvidence =
  | 'TOKEN'
  | 'JOINED_FRAGMENTS'
  | 'MIXED_SCRIPT'
  | 'CHAR_SUBSTITUTION'
  | 'LATIN_TRANSLITERATION'
  | 'REPEATED_LETTERS'
  | 'TARGET_CONTEXT';

export const PROFANITY_CATEGORY_SCORES: Readonly<Record<ProfanityCategory, number>> = {
  CORE_MAT: 0.99,
  SEVERE_ABUSE: 0.95,
  MILD_INSULT: 0.75,
};

export type ProfanityDetectionDecision = {
  category: ProfanityCategory;
  score: number;
  sensitivity: ProfanitySensitivity;
  rolloutMode: ProfanityRolloutMode;
  familyId: string;
  matchKind: ProfanityMatchKind;
  matchedVariant: string;
  evidence: ProfanityEvidence[];
  detectorVersion: string;
};

export type ProfanityViolationMetadata = Omit<ProfanityDetectionDecision, 'score'>;
