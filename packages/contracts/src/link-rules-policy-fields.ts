import { z } from 'zod';
import {
  NAVIGATION_ALLOWLIST_STORED_VALUE_MAX_LENGTH,
  navigationAllowlistKindSchema,
  normalizeNavigationAllowlistTarget,
  type NavigationAllowlistKind,
} from './settings-utils.js';

export const LINK_RULES_MAX = 300;

export const linkRulesModeSchema = z.enum([
  'ALLOW_ALL',
  'DENY_SELECTED',
  'ALLOW_SELECTED',
  'DENY_ALL',
]);
export type LinkRulesMode = z.infer<typeof linkRulesModeSchema>;

export const linkRuleEffectSchema = z.enum(['ALLOW', 'DENY']);
export type LinkRuleEffect = z.infer<typeof linkRuleEffectSchema>;

export function normalizeLinkRuleTarget(
  value: string,
  kind: NavigationAllowlistKind,
): string | null {
  if (value.length > NAVIGATION_ALLOWLIST_STORED_VALUE_MAX_LENGTH) return null;
  const target = normalizeNavigationAllowlistTarget(value, kind);
  return target && target.length <= NAVIGATION_ALLOWLIST_STORED_VALUE_MAX_LENGTH ? target : null;
}

export const linkRuleSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/u),
    effect: linkRuleEffectSchema,
    kind: navigationAllowlistKindSchema,
    target: z.string().min(1).max(NAVIGATION_ALLOWLIST_STORED_VALUE_MAX_LENGTH),
    enabled: z.boolean().default(true),
    expiresAt: z.iso.datetime({ offset: true }).nullable().default(null),
  })
  .strict()
  .transform((rule, ctx) => {
    const target = normalizeLinkRuleTarget(rule.target, rule.kind);
    if (!target) {
      ctx.addIssue({
        code: 'custom',
        path: ['target'],
        message: 'Укажите корректную ссылку, домен или идентификатор MAX.',
      });
      return z.NEVER;
    }
    return { ...rule, target };
  });
export type LinkRule = z.infer<typeof linkRuleSchema>;

export const linkRulesPolicySchema = z
  .object({
    version: z.literal(1),
    mode: linkRulesModeSchema,
    rules: z.array(linkRuleSchema).max(LINK_RULES_MAX, 'До 300 правил для ссылок.'),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const ids = new Set<string>();
    const targets = new Set<string>();
    policy.rules.forEach((rule, index) => {
      if (ids.has(rule.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['rules', index, 'id'],
          message: 'Идентификаторы правил не должны повторяться.',
        });
      }
      const key = `${rule.kind}\0${rule.target}`;
      if (targets.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['rules', index, 'target'],
          message: 'Для этой ссылки или домена уже есть правило.',
        });
      }
      ids.add(rule.id);
      targets.add(key);
    });
  });
export type LinkRulesPolicy = z.infer<typeof linkRulesPolicySchema>;

export const linkRulesLegacySnapshotSchema = z
  .object({
    revision: z
      .string()
      .max(20)
      .regex(/^(?:0|[1-9][0-9]*)$/u),
    policy: linkRulesPolicySchema,
  })
  .strict();
export type LinkRulesLegacySnapshot = z.infer<typeof linkRulesLegacySnapshotSchema>;
