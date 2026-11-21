import { z } from 'zod';

// FLAG: Retired command spellings in saved aliases cannot grant a different action.
export function isRetiredSuperBanCommandText(value: string): boolean {
  return /^[/!]?(?:супер[\s-]+бан|super[\s-]+ban)[.!]?$/iu.test(value.trim());
}

export const REPORT_DEFAULT_TRIGGERS = ['/report', 'жалоба'] as const;
export const reportDeleteModeSchema = z.enum(['MESSAGE', 'HISTORY_24H']);
export const reportSettingsShape = {
  reportsEnabled: z.boolean().default(false),
  reportsThreshold: z.number().int().min(2).max(6).default(3),
  reportsAliases: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .min(1)
        .max(32)
        .regex(/^\/?[\p{L}\p{N}_-]+$/u),
    )
    .max(5)
    .default([]),
  reportsDeleteMode: reportDeleteModeSchema.default('MESSAGE'),
  reportsMuteEnabled: z.boolean().default(false),
  reportsMuteDurationHours: z.number().int().min(1).max(24).default(1),
};
export const reportSettingsSchema = z.object(reportSettingsShape);
export type ReportSettings = z.infer<typeof reportSettingsSchema>;

export function addReportCommandIssues(
  settings: ReportSettings & Record<string, unknown>,
  ctx: z.RefinementCtx,
): void {
  const commands = Object.entries(settings)
    .filter(([key]) => /^admin.*Command(Name|Aliases)$/.test(key))
    .flatMap(([, value]) => (typeof value === 'string' ? value.split(/[\n,;]+/u) : []))
    .map((value) => value.trim().toLowerCase().replace(/^[/!]/u, ''));
  const reserved = new Set([...commands, 'start', 'старт']);
  const triggers = [...REPORT_DEFAULT_TRIGGERS, ...settings.reportsAliases];
  if (new Set(triggers).size !== triggers.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['reportsAliases'],
      message: 'Команды жалоб не должны повторяться.',
    });
  }
  if (
    triggers.some(
      (trigger) =>
        isRetiredSuperBanCommandText(trigger) || reserved.has(trigger.replace(/^[/!]/u, '')),
    )
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['reportsAliases'],
      message: 'Команда жалобы совпадает с командой администратора.',
    });
  }
}
