import { describe, expect, it } from 'vitest';
import {
  buildSuggestionRejectionText,
  suggestionRejectionRequestSchema,
  suggestionReviewWriteSchema,
} from '../src/suggestion-review';
const base = { requestId: 'b4dc924e-2b2f-41d4-a585-43c2b56b5735', expectedRevision: 0 };
describe('suggestion review contract', () => {
  it('preserves whitespace and refuses author mutation', () => {
    expect(suggestionReviewWriteSchema.parse({ ...base, text: '  Текст\n\n' }).text).toBe(
      '  Текст\n\n',
    );
    expect(suggestionReviewWriteSchema.safeParse({ ...base, authorUserId: 'other' }).success).toBe(
      false,
    );
  });
  it('requires a real MAX contact for paid placement and a reason for notifications', () => {
    expect(
      suggestionRejectionRequestSchema.safeParse({ ...base, notifyAuthor: true }).success,
    ).toBe(false);
    expect(
      suggestionRejectionRequestSchema.safeParse({ ...base, notifyAuthor: true, reason: 'paid' })
        .success,
    ).toBe(false);
    for (const contactUrl of [
      'javascript:alert(1)',
      'https://max.ru.evil.test/person',
      'https://user:secret@max.ru/person',
    ]) {
      expect(
        suggestionRejectionRequestSchema.safeParse({
          ...base,
          notifyAuthor: true,
          reason: 'paid',
          contactUrl,
        }).success,
      ).toBe(false);
    }
    expect(
      suggestionRejectionRequestSchema.safeParse({
        ...base,
        notifyAuthor: true,
        reason: 'paid',
        contactUrl: 'https://max.ru/editor',
      }).success,
    ).toBe(true);
    expect(
      suggestionRejectionRequestSchema.safeParse({ ...base, notifyAuthor: false }).success,
    ).toBe(true);
  });
  it('builds the agreed paid-placement response without inventing a tariff', () => {
    expect(buildSuggestionRejectionText('paid', 'Барахолка', 'Напишите время размещения.')).toBe(
      'Спасибо за предложение для «Барахолка». Размещение такого объявления платное. Чтобы согласовать стоимость и условия публикации, свяжитесь с администратором.\n\nНапишите время размещения.',
    );
  });
});
