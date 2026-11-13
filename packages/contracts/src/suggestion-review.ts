import { z } from 'zod';

export const SUGGESTION_REVIEW_TEXT_LIMIT = 4_000;
export const suggestionReviewProfileSchema = z.enum(['moderation', 'publisher']);
export const suggestionRejectionReasonSchema = z.enum(['paid', 'details', 'topic', 'rules']);
export type SuggestionRejectionReason = z.infer<typeof suggestionRejectionReasonSchema>;
export const SUGGESTION_REJECTION_LABELS: Record<SuggestionRejectionReason, string> = {
  paid: 'Платное размещение',
  details: 'Нужно дополнить',
  topic: 'Не по теме',
  rules: 'Не по правилам',
};

export function buildSuggestionRejectionText(
  reason: SuggestionRejectionReason,
  channel: string,
  comment = '',
): string {
  const intro = `Спасибо за предложение для «${channel}».`;
  const messages: Record<SuggestionRejectionReason, string> = {
    paid: 'Размещение такого объявления платное. Чтобы согласовать стоимость и условия публикации, свяжитесь с администратором.',
    details:
      'Пока не можем его опубликовать: не хватает важных подробностей. Дополните описание и отправьте пост повторно.',
    topic:
      'Мы не приняли его к публикации: тема поста не подходит этому каналу. Будем рады материалам по его тематике.',
    rules:
      'Мы не приняли его к публикации: содержание не соответствует правилам канала. Ознакомьтесь с правилами перед отправкой следующего поста.',
  };
  return `${intro} ${messages[reason]}${comment.trim() ? `\n\n${comment.trim()}` : ''}`;
}

export const suggestionReviewWriteSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    // No trimming: offsets, indentation and deliberate blank lines belong to the author.
    text: z.string().max(SUGGESTION_REVIEW_TEXT_LIMIT).optional(),
  })
  .strict();
export type SuggestionReviewWrite = z.infer<typeof suggestionReviewWriteSchema>;

const contactSchema = z
  .string()
  .trim()
  .max(2_048)
  .refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        url.hostname === 'max.ru' &&
        !url.username &&
        !url.password &&
        url.pathname !== '/'
      );
    } catch {
      return false;
    }
  }, 'Укажите ссылку на контакт в MAX: https://max.ru/…');

export const suggestionRejectionRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    notifyAuthor: z.boolean(),
    reason: suggestionRejectionReasonSchema.optional(),
    comment: z.string().trim().max(500).default(''),
    contactUrl: contactSchema.default(''),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.notifyAuthor && !value.reason)
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Выберите причину.' });
    if (value.notifyAuthor && value.reason === 'paid' && !value.contactUrl)
      ctx.addIssue({
        code: 'custom',
        path: ['contactUrl'],
        message: 'Укажите контакт для согласования размещения.',
      });
  });
export type SuggestionRejectionRequest = z.infer<typeof suggestionRejectionRequestSchema>;

export const suggestionReviewDetailSchema = z
  .object({
    id: z.string(),
    profile: suggestionReviewProfileSchema,
    channelId: z.string(),
    channelTitle: z.string(),
    revision: z.number().int().nonnegative(),
    text: z.string(),
    originalText: z.string(),
    status: z.enum(['pending', 'publishing', 'published', 'drafted', 'cancelled']),
    author: z.object({ userId: z.string(), name: z.string(), url: z.string().nullable() }),
    previewText: z.string(),
    previewFormat: z.enum(['plain', 'markdown', 'html']),
    media: z.array(
      z.object({
        id: z.string(),
        type: z.enum(['image', 'video']),
        name: z.string(),
        available: z.boolean(),
      }),
    ),
    contactUrl: z.string(),
    notification: z.enum(['none', 'pending', 'sent', 'failed', 'ambiguous']),
    rejectionText: z.string().nullable(),
  })
  .strict();
export type SuggestionReviewDetail = z.infer<typeof suggestionReviewDetailSchema>;
