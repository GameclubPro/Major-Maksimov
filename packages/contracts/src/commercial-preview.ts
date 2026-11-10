import { z } from 'zod';
import type { CommercialSettingsProfile } from './commercial-settings.js';
import {
  COMMERCIAL_ADS_PREVIEW_TEXT_MAX,
  commercialAdsPolicySchema,
  commercialAdsUserIdSchema,
} from './commercial-policy.js';

export const commercialSettingsProfileSchema: z.ZodType<CommercialSettingsProfile> =
  /* @__PURE__ */ (() =>
    z
      .object({
        commercialAdsSensitivity: z.enum(['BALANCED', 'STRICT']),
        commercialAdsWarnThreshold: z.number().int().min(10).max(90),
        commercialAdsDeleteThreshold: z.number().int().min(20).max(100),
      })
      .strict()
      .refine(
        (profile) => profile.commercialAdsDeleteThreshold > profile.commercialAdsWarnThreshold,
        {
          path: ['commercialAdsDeleteThreshold'],
          message: 'Порог удаления должен быть выше порога предупреждения.',
        },
      ))();

export const commercialAdsPreviewRequestSchema = /* @__PURE__ */ (() =>
  z
    .object({
      text: z
        .string()
        .max(COMMERCIAL_ADS_PREVIEW_TEXT_MAX, 'До 2500 символов.')
        .refine((text) => text.trim().length > 0, 'Введите сообщение.'),
      policy: commercialAdsPolicySchema.nullable(),
      userId: commercialAdsUserIdSchema.nullable().optional(),
      enabled: z.boolean(),
      classification: commercialSettingsProfileSchema.optional(),
    })
    .strict())();
export type CommercialAdsPreviewRequest = z.infer<typeof commercialAdsPreviewRequestSchema>;
