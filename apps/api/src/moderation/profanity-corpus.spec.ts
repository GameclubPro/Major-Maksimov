import {
  PROFANITY_GENERATED_SHOULD_ALLOW_CASES,
  PROFANITY_GENERATED_SHOULD_BLOCK_CASES,
  PROFANITY_PERFORMANCE_CORPUS,
  PROFANITY_SHOULD_ALLOW_CASES,
  PROFANITY_SHOULD_BLOCK_CASES,
} from './profanity-corpus.fixture';
import type {
  ProfanityDetectionDecision,
  ProfanityRolloutMode,
  ProfanitySensitivity,
} from './profanity/profanity.types';
import { RuleEngineService } from './rule-engine.service';

type PrivateProfanityProbe = {
  detectProfanity(
    text: string,
    sensitivity: ProfanitySensitivity,
    rolloutMode?: ProfanityRolloutMode,
  ): ProfanityDetectionDecision | null;
};

function createProfanityProbe() {
  const probe = new RuleEngineService({} as never) as unknown as PrivateProfanityProbe;
  return {
    detect(
      text: string,
      sensitivity: ProfanitySensitivity = 'STRICT',
      rolloutMode: ProfanityRolloutMode = 'legacy',
    ) {
      return probe.detectProfanity(text, sensitivity, rolloutMode);
    },
    hasProfanity(text: string) {
      return probe.detectProfanity(text, 'STRICT', 'legacy') !== null;
    },
  };
}

describe('profanity corpus', () => {
  const probe = createProfanityProbe();

  it.each(PROFANITY_SHOULD_BLOCK_CASES)('blocks abusive corpus case %#', (text) => {
    expect(probe.hasProfanity(text)).toBe(true);
  });

  it.each(PROFANITY_SHOULD_ALLOW_CASES)('allows safe corpus case %#', (text) => {
    expect(probe.hasProfanity(text)).toBe(false);
  });

  it('keeps mild insults out of BALANCED and detects them with structured STRICT metadata', () => {
    expect(probe.detect('скотина', 'BALANCED', 'on')).toBeNull();
    expect(probe.detect('ты скотина', 'BALANCED', 'on')).toBeNull();
    expect(probe.detect('ты валенок', 'BALANCED', 'on')).toBeNull();
    expect(probe.detect('ты полный дурак', 'BALANCED', 'on')).toBeNull();
    expect(probe.detect('ты кретин', 'BALANCED', 'on')).toBeNull();
    expect(probe.detect('ты лох', 'BALANCED', 'on')).toBeNull();
    expect(probe.detect('скотина', 'STRICT', 'on')).toBeNull();

    expect(probe.detect('ты скотина', 'STRICT', 'on')).toEqual(
      expect.objectContaining({
        category: 'MILD_INSULT',
        score: 0.75,
        sensitivity: 'STRICT',
        rolloutMode: 'on',
        familyId: 'exact:скотин',
        matchKind: 'EXACT_VARIANT',
        matchedVariant: 'скотина',
        evidence: expect.arrayContaining(['TARGET_CONTEXT']),
        detectorVersion: 'profanity-structured-v4',
      }),
    );
    expect(probe.detect('ты валенок', 'STRICT', 'on')).toEqual(
      expect.objectContaining({
        category: 'MILD_INSULT',
        score: 0.75,
        familyId: 'targeted:вален',
        matchKind: 'TARGETED_VARIANT',
        evidence: expect.arrayContaining(['TARGET_CONTEXT']),
      }),
    );
    expect(probe.detect('ты полный дурак', 'STRICT', 'on')).toEqual(
      expect.objectContaining({
        category: 'MILD_INSULT',
        score: 0.75,
        familyId: 'targeted:дурак',
        evidence: expect.arrayContaining(['TARGET_CONTEXT']),
      }),
    );
    expect(probe.detect('ты кретин', 'STRICT', 'on')).toEqual(
      expect.objectContaining({ category: 'MILD_INSULT', score: 0.75 }),
    );
    expect(probe.detect('ты лох', 'STRICT', 'on')).toEqual(
      expect.objectContaining({ category: 'MILD_INSULT', score: 0.75 }),
    );
    expect(probe.detect('ты чурка', 'BALANCED', 'on')).toEqual(
      expect.objectContaining({ category: 'SEVERE_ABUSE', score: 0.95 }),
    );
    expect(probe.detect('ты скотина, а потом блять', 'STRICT', 'on')).toEqual(
      expect.objectContaining({ category: 'CORE_MAT', score: 0.99, familyId: 'core:blyad' }),
    );
    expect(probe.detect('ты валенок и мразь', 'STRICT', 'on')).toEqual(
      expect.objectContaining({ category: 'SEVERE_ABUSE', score: 0.95 }),
    );
  });

  it('keeps only core mat in CORE_ONLY and preserves legacy rollback behavior', () => {
    expect(probe.detect('ты идиот и мразь', 'CORE_ONLY', 'on')).toBeNull();
    expect(probe.detect('ты скотина', 'CORE_ONLY', 'on')).toBeNull();
    expect(probe.detect('ты скотина', 'CORE_ONLY', 'legacy')).toEqual(
      expect.objectContaining({ category: 'MILD_INSULT', score: 0.95, rolloutMode: 'legacy' }),
    );
    expect(probe.detect('д у р а к', 'STRICT', 'on')).toBeNull();
    expect(probe.detect('д у р а к', 'CORE_ONLY', 'legacy')).toEqual(
      expect.objectContaining({ category: 'MILD_INSULT', score: 0.95, rolloutMode: 'legacy' }),
    );
    expect(probe.detect('ты валенок', 'STRICT', 'legacy')).toBeNull();
    expect(probe.detect('бл@ть', 'CORE_ONLY', 'on')).toEqual(
      expect.objectContaining({
        category: 'CORE_MAT',
        score: 0.99,
        familyId: 'core:blyad',
        matchKind: 'CORE_PATTERN',
        evidence: expect.arrayContaining(['CHAR_SUBSTITUTION']),
      }),
    );
  });

  it('allows thousands of generated real-world safe scenarios', () => {
    expect(PROFANITY_GENERATED_SHOULD_ALLOW_CASES.length).toBeGreaterThanOrEqual(3_000);

    const falsePositiveCases = PROFANITY_GENERATED_SHOULD_ALLOW_CASES.filter((text) =>
      probe.hasProfanity(text),
    );

    expect({
      count: falsePositiveCases.length,
      samples: falsePositiveCases.slice(0, 30),
    }).toEqual({ count: 0, samples: [] });
  });

  it('allows numeric size lists across separators and price labels', () => {
    const falsePositiveCases: string[] = [];
    for (let size = 20; size <= 52; size += 1) {
      for (const separator of ['.', ', ', ';', '/', '-', ' ', '\n']) {
        for (const priceLabel of ['от', 'за', 'по']) {
          const text = `Обувь ${size}${separator}${size + 1}${separator}${size + 2} ${priceLabel} 1000 руб.`;
          if (probe.hasProfanity(text)) {
            falsePositiveCases.push(text);
          }
        }
      }
    }

    expect(falsePositiveCases).toEqual([]);
  });

  it('blocks generated abusive profanity and insult scenarios', () => {
    expect(PROFANITY_GENERATED_SHOULD_BLOCK_CASES.length).toBeGreaterThanOrEqual(250);

    const missedCases = PROFANITY_GENERATED_SHOULD_BLOCK_CASES.filter(
      (text) => !probe.hasProfanity(text),
    );

    expect({
      count: missedCases.length,
      samples: missedCases.slice(0, 30),
    }).toEqual({ count: 0, samples: [] });
  });

  it('allows Russian age ranges without exempting independent mat in either rollout', () => {
    const failures: Array<{ text: string; rolloutMode: string; sensitivity: string }> = [];
    for (const rolloutMode of ['on', 'legacy'] as const) {
      for (const sensitivity of ['CORE_ONLY', 'BALANCED', 'STRICT'] as const) {
        for (let age = 2; age <= 16; age += 1) {
          for (const separator of ['-', '–', ' — ']) {
            for (const unit of ['л.', ' л.', 'лет', ' лет', '-летние']) {
              const text = `Приглашаем детей в группу ${age}${separator}${age + 3}${unit}`;
              if (
                probe.detect(text, sensitivity, rolloutMode) ||
                probe.detect(`${text}, блять`, sensitivity, rolloutMode)?.category !== 'CORE_MAT'
              ) {
                failures.push({ text, rolloutMode, sensitivity });
              }
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('keeps profanity detection within the hot-path budget', () => {
    const sampleCount = 20_000;
    const budgetMs = Number(process.env.PROFANITY_PERF_BUDGET_MS ?? '0.5');
    const samples = Array.from(
      { length: sampleCount },
      (_, index) => PROFANITY_PERFORMANCE_CORPUS[index % PROFANITY_PERFORMANCE_CORPUS.length]!,
    );

    for (let index = 0; index < 1_000; index += 1) {
      probe.hasProfanity(samples[index % samples.length]!);
    }

    const startedAt = process.hrtime.bigint();
    let profanityHits = 0;
    for (const sample of samples) {
      if (probe.hasProfanity(sample)) {
        profanityHits += 1;
      }
    }
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const perMessageMs = elapsedMs / samples.length;

    expect(profanityHits).toBeGreaterThan(0);
    expect(perMessageMs).toBeLessThanOrEqual(budgetMs);
  });
});
