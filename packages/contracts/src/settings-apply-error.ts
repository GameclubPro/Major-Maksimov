import { z } from 'zod';

export const settingsApplyPartialErrorSchema = /*#__PURE__*/ (() =>
  z
    .object({
      code: z.enum(['SETTINGS_APPLY_PARTIAL', 'CHAT_SETTINGS_CONCURRENT_UPDATE']),
      message: z.string().max(500),
      partialApplied: z.literal(true),
      sourceChatId: z.string(),
      sourceSettingsRevision: z.string().datetime().optional(),
      targetCount: z.number().int().positive(),
      appliedCount: z.number().int().positive(),
      unchangedCount: z.number().int().nonnegative(),
      failedCount: z.number().int().nonnegative(),
      notAttemptedCount: z.number().int().nonnegative(),
      appliedChatIds: z.array(z.string()).max(20),
      unchangedChatIds: z.array(z.string()).max(20),
      outcomes: z
        .array(
          z.object({
            chatId: z.string(),
            status: z.enum(['APPLIED', 'FAILED', 'NOT_ATTEMPTED']),
            reasonCode: z.string().max(80).optional(),
            message: z.string().max(500).optional(),
          }),
        )
        .max(20),
      outcomesTruncated: z.boolean(),
      causeCode: z.enum([
        'REPORTS_COMMAND_CONFLICT',
        'REPORTS_UNAVAILABLE',
        'BOT_CAPABILITY_REQUIRED',
        'CHAT_SETTINGS_CONCURRENT_UPDATE',
        'SETTINGS_WRITE_FAILED',
        'POST_COMMIT_REFRESH_FAILED',
      ]),
      causeMessage: z.string().max(500),
      chatId: z.string().optional(),
    })
    .superRefine((value, ctx) => {
      if (
        value.appliedCount + value.unchangedCount !== value.targetCount ||
        value.failedCount + value.notAttemptedCount !== value.unchangedCount
      ) {
        ctx.addIssue({ code: 'custom', message: 'Некорректный итог применения настроек.' });
      }
    }))();
export type SettingsApplyPartialError = z.infer<typeof settingsApplyPartialErrorSchema>;

export const settingsSectionApplyRevisionShape = {
  expectedSourceRevision: z.number().int().nonnegative().optional(),
  expectedSourceSettingsRevision: z.string().datetime().optional(),
  confirmedTargetChatIds: z.array(z.string().trim().min(1)).min(1).max(500).optional(),
};

type SettingsSectionApplyRevision = z.infer<z.ZodObject<typeof settingsSectionApplyRevisionShape>>;

export function addSettingsSectionApplyIssues(
  value: SettingsSectionApplyRevision & { section: string },
  ctx: z.RefinementCtx,
): void {
  if (value.section === 'stopWords' && value.expectedSourceRevision === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['expectedSourceRevision'],
      message: 'Обновите раздел стоп-слов перед копированием.',
    });
  }
  if (value.section === 'reports' || value.section === 'night') {
    if (value.expectedSourceSettingsRevision === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['expectedSourceSettingsRevision'],
        message:
          value.section === 'night'
            ? 'Обновите ночной режим перед копированием.'
            : 'Обновите систему жалоб перед копированием.',
      });
    }
    if (value.confirmedTargetChatIds === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['confirmedTargetChatIds'],
        message: 'Подтвердите список чатов перед копированием настроек.',
      });
    }
  }
}
