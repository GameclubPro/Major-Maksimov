import { z } from 'zod';
import { linkRulesPolicySchema } from './link-rules-policy-fields.js';

export const linkRulesPreviewRequestSchema = z
  .object({
    policy: linkRulesPolicySchema,
    text: z.string().min(1).max(10_000),
  })
  .strict();
export type LinkRulesPreviewRequest = z.infer<typeof linkRulesPreviewRequestSchema>;

export const linkRulesPreviewResponseSchema = z
  .object({
    allowed: z.boolean(),
    reason: z.string(),
    target: z.string().optional(),
    ruleId: z.string().optional(),
    targetsCount: z.number().int().nonnegative(),
  })
  .strict();
export type LinkRulesPreviewResponse = z.infer<typeof linkRulesPreviewResponseSchema>;
