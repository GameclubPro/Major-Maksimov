import { describe, expect, it } from 'vitest';
import { applySectionToAllRequestSchema, settingsApplyPartialErrorSchema } from '../src/core.js';

const sourceRevision = '2026-10-01T10:00:00.000Z';

describe('confirmed report policy application', () => {
  it.each(['reports', 'night'] as const)(
    'requires the saved source revision and exact confirmed targets for %s',
    (section) => {
      expect(applySectionToAllRequestSchema.safeParse({ section }).success).toBe(false);
      expect(
        applySectionToAllRequestSchema.safeParse({
          section,
          expectedSourceRevision: 1,
          confirmedTargetChatIds: ['source'],
        }).success,
      ).toBe(false);
      expect(
        applySectionToAllRequestSchema.parse({
          section,
          expectedSourceSettingsRevision: sourceRevision,
          confirmedTargetChatIds: ['source'],
        }).target.mode,
      ).toBe('current');
    },
  );

  it('retains numeric stop-list revisions and rejects silently truncated confirmations', () => {
    expect(
      applySectionToAllRequestSchema.safeParse({ section: 'stopWords', expectedSourceRevision: 1 })
        .success,
    ).toBe(true);
    expect(
      applySectionToAllRequestSchema.safeParse({
        section: 'reports',
        expectedSourceSettingsRevision: sourceRevision,
        confirmedTargetChatIds: Array.from({ length: 501 }, (_, index) => `chat-${index}`),
      }).success,
    ).toBe(false);
  });

  it('validates exact totals independently of bounded per-chat samples', () => {
    const error = {
      code: 'SETTINGS_APPLY_PARTIAL',
      message: 'Настройки применены частично.',
      partialApplied: true,
      sourceChatId: 'source',
      targetCount: 30,
      appliedCount: 28,
      unchangedCount: 2,
      failedCount: 1,
      notAttemptedCount: 1,
      appliedChatIds: ['chat-1'],
      unchangedChatIds: ['chat-29', 'chat-30'],
      outcomes: [
        { chatId: 'chat-29', status: 'FAILED', reasonCode: 'REPORTS_COMMAND_CONFLICT' },
        { chatId: 'chat-30', status: 'NOT_ATTEMPTED' },
      ],
      outcomesTruncated: true,
      causeCode: 'REPORTS_COMMAND_CONFLICT',
      causeMessage: 'Команды совпадают.',
    };
    expect(settingsApplyPartialErrorSchema.safeParse(error).success).toBe(true);
    expect(settingsApplyPartialErrorSchema.safeParse({ ...error, unchangedCount: 3 }).success).toBe(
      false,
    );
    expect(
      settingsApplyPartialErrorSchema.safeParse({ ...error, partialApplied: false }).success,
    ).toBe(false);
  });
});
