import { z } from 'zod';
import { MAX_HTTP_BUTTON_URL_LENGTH, normalizeHttpButtonUrl } from './button-url.js';
import { isValidBotButtonUrl } from './settings-message-field-schemas.js';

export const CHANNEL_POST_SIGNATURE_DEFAULT_TEXT = 'Подписаться на канал';
export const CHANNEL_POST_SIGNATURE_TEXT_MAX_LENGTH = 120;
export const CHANNEL_POST_SIGNATURE_URL_MAX_LENGTH = 256;
export const CHANNEL_POST_BUTTON_TEXT_MAX_LENGTH = 32;
export const MAX_CHANNEL_CUSTOM_BUTTONS = 8;
export const channelCustomPostButtonSchema = z.object({
  id: z.string().uuid(),
  text: z.string().trim().min(1, 'Введите название кнопки.').max(32),
  url: z
    .string()
    .trim()
    .min(1, 'Укажите ссылку.')
    .max(MAX_HTTP_BUTTON_URL_LENGTH)
    .refine((value) => {
      const normalized = normalizeHttpButtonUrl(value);
      if (!normalized || !isValidBotButtonUrl(value)) return false;
      const url = new URL(normalized);
      return !url.username && !url.password;
    }, 'Укажите ссылку http:// или https:// без логина и пароля.')
    .transform((value) => normalizeHttpButtonUrl(value)!),
});
export type ChannelCustomPostButton = z.infer<typeof channelCustomPostButtonSchema>;
export const channelCustomPostButtonsSchema = z
  .array(channelCustomPostButtonSchema)
  .max(MAX_CHANNEL_CUSTOM_BUTTONS, 'Можно добавить до 8 кнопок.')
  .superRefine((buttons, ctx) => {
    const ids = new Set<string>();
    const urls = new Set<string>();
    buttons.forEach((button, index) => {
      if (ids.has(button.id))
        ctx.addIssue({ code: 'custom', path: [index, 'id'], message: 'Кнопка повторяется.' });
      if (urls.has(button.url))
        ctx.addIssue({
          code: 'custom',
          path: [index, 'url'],
          message: 'Кнопка с этой ссылкой уже есть.',
        });
      ids.add(button.id);
      urls.add(button.url);
    });
  });

export const channelPostSignaturePresentationSchema = z.enum(['signature', 'button']);
export type ChannelPostSignaturePresentation = z.infer<
  typeof channelPostSignaturePresentationSchema
>;

function normalizeChannelPostSignatureUrl(value: string): string | null {
  const normalized = normalizeHttpButtonUrl(value);
  if (!normalized || normalized.length > CHANNEL_POST_SIGNATURE_URL_MAX_LENGTH) {
    return null;
  }

  const parsed = new URL(normalized);
  return parsed.username || parsed.password ? null : normalized;
}

export const channelPostSignatureUrlSchema = z
  .string()
  .trim()
  .max(CHANNEL_POST_SIGNATURE_URL_MAX_LENGTH)
  .refine((value) => value.length === 0 || normalizeChannelPostSignatureUrl(value) !== null, {
    message: 'Укажите корректную ссылку (http/https) без логина и пароля.',
  })
  .transform((value) => (value.length === 0 ? '' : normalizeChannelPostSignatureUrl(value)!));

export const channelPostSignatureSettingsSchema = z
  .object({
    revision: z.number().int().nonnegative().optional(),
    enabled: z.boolean().default(false),
    presentation: channelPostSignaturePresentationSchema.default('signature'),
    text: z
      .string()
      .trim()
      .min(1, 'Укажите текст ссылки на канал.')
      .max(CHANNEL_POST_SIGNATURE_TEXT_MAX_LENGTH)
      .default(CHANNEL_POST_SIGNATURE_DEFAULT_TEXT),
    url: channelPostSignatureUrlSchema.default(''),
    customButtonsEnabled: z.boolean().default(false),
    customButtons: channelCustomPostButtonsSchema.default([]),
  })
  .superRefine((value, ctx) => {
    if (
      value.presentation === 'button' &&
      value.text.length > CHANNEL_POST_BUTTON_TEXT_MAX_LENGTH
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: CHANNEL_POST_BUTTON_TEXT_MAX_LENGTH,
        origin: 'string',
        inclusive: true,
        path: ['text'],
        message: `Текст кнопки не должен превышать ${CHANNEL_POST_BUTTON_TEXT_MAX_LENGTH} символа.`,
      });
    }
  });
export type ChannelPostSignatureSettings = z.infer<typeof channelPostSignatureSettingsSchema>;

export const updateChannelPostSignatureRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    enabled: z.boolean().optional(),
    presentation: channelPostSignaturePresentationSchema.optional(),
    text: z
      .string()
      .trim()
      .min(1, 'Укажите текст ссылки на канал.')
      .max(CHANNEL_POST_SIGNATURE_TEXT_MAX_LENGTH)
      .optional(),
    url: channelPostSignatureUrlSchema.optional(),
    customButtonsEnabled: z.boolean().optional(),
    customButtons: channelCustomPostButtonsSchema.optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== 'expectedRevision'), {
    message: 'Передайте хотя бы одну настройку.',
  });
export type UpdateChannelPostSignatureRequest = z.infer<
  typeof updateChannelPostSignatureRequestSchema
>;
