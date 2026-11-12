import { commercialAdsPolicySchema } from '@maxim/contracts/settings';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  sanitizeCommercialCorpusText,
  hasResidualCommercialContactCandidate,
} from '../../scripts/commercial-corpus-sanitization.util';
import {
  fingerprintCommercialDeleteSettings,
  fingerprintCommercialDeleteText,
  type CommercialDeleteSettings,
} from './commercial-delete-binding';
import {
  COMMERCIAL_LLM_MODEL_SHA256,
  COMMERCIAL_LLM_PROMPT_SHA256,
  COMMERCIAL_LLM_RUNTIME_IMAGE_SHA256,
  COMMERCIAL_LLM_POLICY_VERSION,
  COMMERCIAL_LLM_CHAT_TEMPLATE_SHA256,
  parseCommercialLlmDecision,
  type CommercialLlmObservationResult,
} from './commercial-llm.protocol';
import {
  COMMERCIAL_LLM_CASCADE_VERSION,
  COMMERCIAL_LLM_WORKSTATION_IDENTITY,
} from './commercial-llm-workstation.protocol';
import {
  COMMERCIAL_LLM_POOL_PROFILES,
  LEGACY_COMMERCIAL_LLM_POOL_PROFILES,
  LEGACY_POOL_NODE_IDS,
  type CommercialLlmPoolNodeId,
  isCommercialLlmPoolNodeId,
} from './commercial-llm-pool.protocol';

export const COMMERCIAL_LLM_DELETE_RULE_CODE = 'COMMERCIAL_LLM_DELETE';
export const COMMERCIAL_LLM_ENFORCEMENT_VERSION = 1;
export const COMMERCIAL_LLM_EFFECT_MAX_AGE_MS = 60_000;
export const COMMERCIAL_LLM_INFERENCE_TIMEOUT_MS = 20_000;
export const COMMERCIAL_LLM_PENDING_MAX_AGE_MS = 3_000;
export const COMMERCIAL_LLM_ENFORCEMENT_IDENTITY_SHA256 = createHash('sha256')
  .update(
    JSON.stringify([
      COMMERCIAL_LLM_ENFORCEMENT_VERSION,
      COMMERCIAL_LLM_MODEL_SHA256,
      COMMERCIAL_LLM_PROMPT_SHA256,
      COMMERCIAL_LLM_RUNTIME_IMAGE_SHA256,
      COMMERCIAL_LLM_WORKSTATION_IDENTITY,
      COMMERCIAL_LLM_CASCADE_VERSION,
    ]),
  )
  .digest('hex');
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const originSchema = z
  .object({
    sourceWebhookEventId: z.string().min(1).max(128),
    sourceReceivingBotId: z.string().min(1).max(100),
    sourceExecutionBotId: z.string().min(1).max(100),
    sourceEventAtMs: z.number().int().positive().safe(),
    sourceEvidenceVersion: z.literal(1),
  })
  .strict();
const legacyCommercialLlmSourceSchema = z
  .object({
    version: z.literal(COMMERCIAL_LLM_ENFORCEMENT_VERSION),
    classifierSha256: z.literal(COMMERCIAL_LLM_ENFORCEMENT_IDENTITY_SHA256),
    origin: originSchema,
    nonce: z.uuid(),
    chatId: z.string().min(1).max(100),
    messageId: z.string().min(1).max(200),
    userId: z.string().min(1).max(100),
    originBotId: z.string().min(1).max(100),
    eventAtMs: z.number().int().positive().safe(),
    deadlineAtMs: z.number().int().positive().safe(),
    sourceSha256: sha,
    settingsSha256: sha,
  })
  .strict();
export type CommercialLlmPoolPolicy = 'confirm-positive' | 'direct-4b';
export const COMMERCIAL_LLM_POOL_FOUR_NODE_READER_VERSION = 1;
export function legacyCommercialLlmPoolEnforcementIdentity(
  policy: CommercialLlmPoolPolicy,
): string {
  return createHash('sha256')
    .update(JSON.stringify(['commercial-pool-v2', LEGACY_COMMERCIAL_LLM_POOL_PROFILES, policy]))
    .digest('hex');
}
export function commercialLlmPoolEnforcementIdentity(policy: CommercialLlmPoolPolicy): string {
  return createHash('sha256')
    .update(JSON.stringify(['commercial-pool-v2', COMMERCIAL_LLM_POOL_PROFILES, policy]))
    .digest('hex');
}
// FLAG: Existing v1 serialization and proofs are retained. New routing/4B authority
// has a distinct source identity, and disabling its policy revokes execution separately.
export function commercialLlmPolicyEnforcementIdentity(policy?: CommercialLlmPoolPolicy): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'commercial-category-policy-v1',
        policy
          ? commercialLlmPoolEnforcementIdentity(policy)
          : COMMERCIAL_LLM_ENFORCEMENT_IDENTITY_SHA256,
      ]),
    )
    .digest('hex');
}
export function legacyCommercialLlmPolicyEnforcementIdentity(
  policy: CommercialLlmPoolPolicy,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'commercial-category-policy-v1',
        legacyCommercialLlmPoolEnforcementIdentity(policy),
      ]),
    )
    .digest('hex');
}
// FLAG: Explicit category policy has a distinct source identity. Legacy readers reject v3;
// a policy-bound personal-sale decision never borrows legacy COMMERCIAL deletion authority.
export const commercialLlmSourceSchema = z.union([
  legacyCommercialLlmSourceSchema,
  legacyCommercialLlmSourceSchema.extend({
    version: z.literal(2),
    classifierSha256: z.union([
      z.literal(commercialLlmPoolEnforcementIdentity('confirm-positive')),
      z.literal(legacyCommercialLlmPoolEnforcementIdentity('confirm-positive')),
    ]),
    poolPolicy: z.literal('confirm-positive'),
  }),
  legacyCommercialLlmSourceSchema.extend({
    version: z.literal(2),
    classifierSha256: z.union([
      z.literal(commercialLlmPoolEnforcementIdentity('direct-4b')),
      z.literal(legacyCommercialLlmPoolEnforcementIdentity('direct-4b')),
    ]),
    poolPolicy: z.literal('direct-4b'),
  }),
  legacyCommercialLlmSourceSchema.extend({
    version: z.literal(3),
    classifierSha256: z.literal(commercialLlmPolicyEnforcementIdentity()),
    personalSaleBlocked: z.boolean(),
  }),
  ...(['confirm-positive', 'direct-4b'] as const).map((policy) =>
    legacyCommercialLlmSourceSchema.extend({
      version: z.literal(3),
      classifierSha256: z.union([
        z.literal(commercialLlmPolicyEnforcementIdentity(policy)),
        z.literal(legacyCommercialLlmPolicyEnforcementIdentity(policy)),
      ]),
      poolPolicy: z.literal(policy),
      personalSaleBlocked: z.boolean(),
    }),
  ),
]);
export type CommercialLlmSource = z.infer<typeof commercialLlmSourceSchema>;
// FLAG: A retained three-node source never acquires the fourth node's deletion capability.
// Compare the original generation before converting v3 policy sources or inspecting a result.
export function commercialLlmPoolSourceAllowsNode(
  source: CommercialLlmSource,
  nodeId: CommercialLlmPoolNodeId,
): boolean {
  if (!('poolPolicy' in source) || !isCommercialLlmPoolNodeId(nodeId)) return false;
  const policy = source.poolPolicy;
  if (source.version !== 2 && source.version !== 3) return false;
  const currentIdentity =
    source.version === 2
      ? commercialLlmPoolEnforcementIdentity(policy)
      : commercialLlmPolicyEnforcementIdentity(policy);
  if (source.classifierSha256 === currentIdentity) return true;
  const legacyIdentity =
    source.version === 2
      ? legacyCommercialLlmPoolEnforcementIdentity(policy)
      : legacyCommercialLlmPolicyEnforcementIdentity(policy);
  return (
    source.classifierSha256 === legacyIdentity &&
    LEGACY_POOL_NODE_IDS.some((legacyNodeId) => legacyNodeId === nodeId)
  );
}
export const commercialLlmRequestSchema = z
  .object({
    source: commercialLlmSourceSchema,
    excerpt: z.string().min(1).max(2500),
    submittedAtMs: z.number().int().positive().safe(),
    worker: z.uuid(),
    // FLAG: Optional sampling hint grants no execution authority and contains no source text.
    observationRequested: z.literal(true).optional(),
  })
  .strict();
export type CommercialLlmRequest = z.infer<typeof commercialLlmRequestSchema>;

export function commercialLlmSourceCurrent(source: CommercialLlmSource, now = Date.now()): boolean {
  return (
    source.origin.sourceEventAtMs === source.eventAtMs &&
    source.origin.sourceExecutionBotId === source.originBotId &&
    source.eventAtMs <= now + 5_000 &&
    source.deadlineAtMs === source.eventAtMs + COMMERCIAL_LLM_EFFECT_MAX_AGE_MS &&
    source.deadlineAtMs > now
  );
}

export type CommercialLlmOfferRejection =
  | 'filter_disabled'
  | 'invalid_origin'
  | 'empty_text'
  | 'oversized_text'
  | 'invalid_event_time'
  | 'stale_event'
  | 'unsanitized_contact';

export function prepareCommercialLlmOffer(
  input: {
    chatId: string;
    messageId: string;
    userId: string;
    originBotId?: string;
    text: string;
    eventAt: string | null;
    settings: CommercialDeleteSettings;
    origin?: z.infer<typeof originSchema>;
  },
  now = Date.now(),
  poolPolicy?: CommercialLlmPoolPolicy,
):
  | { offer: { source: CommercialLlmSource; excerpt: string }; reason?: never }
  | { offer?: never; reason: CommercialLlmOfferRejection } {
  if (!input.settings.commercialAdsFilterEnabled) return { reason: 'filter_disabled' };
  if (!input.origin || !input.originBotId) return { reason: 'invalid_origin' };
  if (!input.text.trim()) return { reason: 'empty_text' };
  if (input.text.length > 2500) return { reason: 'oversized_text' };
  if (!input.eventAt) return { reason: 'invalid_event_time' };
  const eventAtMs = Date.parse(input.eventAt);
  // FLAG: Admission never renews the event deadline or accepts historical/replayed sources.
  if (!Number.isFinite(eventAtMs)) return { reason: 'invalid_event_time' };
  if (eventAtMs < now - 10_000 || eventAtMs > now + 5_000) return { reason: 'stale_event' };
  const excerpt = sanitizeCommercialCorpusText(input.text);
  if (!excerpt.trim() || excerpt.length > 2500 || hasResidualCommercialContactCandidate(excerpt))
    return { reason: 'unsanitized_contact' };
  const source = commercialLlmSourceSchema.safeParse({
    version:
      input.settings.commercialAdsPolicy != null
        ? 3
        : poolPolicy
          ? 2
          : COMMERCIAL_LLM_ENFORCEMENT_VERSION,
    classifierSha256:
      input.settings.commercialAdsPolicy != null
        ? commercialLlmPolicyEnforcementIdentity(poolPolicy)
        : poolPolicy
          ? commercialLlmPoolEnforcementIdentity(poolPolicy)
          : COMMERCIAL_LLM_ENFORCEMENT_IDENTITY_SHA256,
    ...(input.settings.commercialAdsPolicy != null
      ? {
          personalSaleBlocked:
            commercialAdsPolicySchema.safeParse(input.settings.commercialAdsPolicy).success &&
            commercialAdsPolicySchema.parse(input.settings.commercialAdsPolicy).categories
              .PERSONAL_SALE === 'BLOCK',
        }
      : {}),
    nonce: randomUUID(),
    origin: input.origin,
    chatId: input.chatId,
    messageId: input.messageId,
    userId: input.userId,
    originBotId: input.originBotId,
    eventAtMs,
    deadlineAtMs: eventAtMs + COMMERCIAL_LLM_EFFECT_MAX_AGE_MS,
    sourceSha256: fingerprintCommercialDeleteText(input.text),
    settingsSha256: fingerprintCommercialDeleteSettings(input.settings),
    ...(poolPolicy ? { poolPolicy } : {}),
  });
  return source.success && commercialLlmSourceCurrent(source.data, now)
    ? { offer: { source: source.data, excerpt } }
    : { reason: 'invalid_origin' };
}

export function buildCommercialLlmOffer(
  input: Parameters<typeof prepareCommercialLlmOffer>[0],
  now = Date.now(),
  poolPolicy?: CommercialLlmPoolPolicy,
): { source: CommercialLlmSource; excerpt: string } | null {
  return prepareCommercialLlmOffer(input, now, poolPolicy).offer ?? null;
}

export function commercialLlmSourceKey(source: CommercialLlmSource): string {
  return createHash('sha256').update(JSON.stringify(source)).digest('hex');
}

// FLAG: Historical SHADOW rows never enter this boundary. A newly admitted source needs
// a successful, pinned server answer; audited disagreement with a local negative is a KEEP.
export function commercialLlmMayDelete(
  result: CommercialLlmObservationResult,
  source?: CommercialLlmSource,
): boolean {
  if (source?.version === 3) {
    const legacy = legacySourceForPolicy(source);
    return legacy !== null && commercialLlmMayDelete(result, legacy);
  }
  if (source?.version === 2 || result.pool) return poolMayDelete(result, source);
  return (
    parseCommercialLlmDecision({
      classification: result.classification,
      reasonCodes: result.reasonCodes,
    })?.classification === 'COMMERCIAL' &&
    commercialLlmHasPinnedServerIdentity(result) &&
    result.cascade?.version === COMMERCIAL_LLM_CASCADE_VERSION &&
    result.cascade.primaryModelSha256 === COMMERCIAL_LLM_WORKSTATION_IDENTITY.modelSha256 &&
    result.cascade.route.startsWith('secondary_') &&
    result.cascade.primaryClassification !== 'NOT_COMMERCIAL'
  );
}

function poolMayDelete(
  result: CommercialLlmObservationResult,
  source?: CommercialLlmSource,
): boolean {
  const pool = result.pool;
  if (
    source?.version !== 2 ||
    !pool ||
    pool.version !== 'commercial-pool-v2' ||
    pool.policy !== source.poolPolicy ||
    !isCommercialLlmPoolNodeId(pool.nodeId) ||
    (pool.attempts !== 1 && pool.attempts !== 2) ||
    !commercialLlmPoolSourceAllowsNode(source, pool.nodeId) ||
    parseCommercialLlmDecision({
      classification: result.classification,
      reasonCodes: result.reasonCodes,
    })?.classification !== 'COMMERCIAL'
  )
    return false;
  const profile = COMMERCIAL_LLM_POOL_PROFILES[pool.nodeId];
  const identity = profile.identity;
  if (
    result.modelAlias !== identity.modelAlias ||
    result.modelSha256 !== identity.modelSha256 ||
    result.promptSha256 !== identity.promptSha256 ||
    result.chatTemplateSha256 !== identity.chatTemplateSha256 ||
    result.runtimeVersion !== identity.runtimeVersion ||
    result.runtimeImageSha256 !== identity.runtimeImageSha256 ||
    result.runtimeArtifactSha256 !== identity.runtimeArtifactSha256 ||
    result.runtimeSupportSha256 !== identity.runtimeSupportSha256 ||
    result.policyVersion !== COMMERCIAL_LLM_POLICY_VERSION
  )
    return false;
  if (pool.route === 'direct') {
    return (
      pool.primaryNodeId === undefined &&
      pool.primaryClassification === undefined &&
      pool.consultationOutcome === undefined &&
      (profile.model === '9b' || source.poolPolicy === 'direct-4b')
    );
  }
  return (
    pool.route === 'consulted' &&
    profile.model === '9b' &&
    pool.primaryNodeId === 'pc-a-4b' &&
    pool.consultationOutcome === 'completed' &&
    (pool.primaryClassification === 'UNSURE' ||
      (source.poolPolicy === 'confirm-positive' && pool.primaryClassification === 'COMMERCIAL'))
  );
}

function legacySourceForPolicy(source: CommercialLlmSource): CommercialLlmSource | null {
  if (source.version !== 3) return null;
  const policy = 'poolPolicy' in source ? source.poolPolicy : undefined;
  const legacyPool =
    policy !== undefined &&
    source.classifierSha256 === legacyCommercialLlmPolicyEnforcementIdentity(policy);
  if (!legacyPool && source.classifierSha256 !== commercialLlmPolicyEnforcementIdentity(policy))
    return null;
  const base: Partial<typeof source> = { ...source };
  delete base.personalSaleBlocked;
  return commercialLlmSourceSchema.parse({
    ...base,
    version: policy ? 2 : 1,
    classifierSha256: policy
      ? legacyPool
        ? legacyCommercialLlmPoolEnforcementIdentity(policy)
        : commercialLlmPoolEnforcementIdentity(policy)
      : COMMERCIAL_LLM_ENFORCEMENT_IDENTITY_SHA256,
  });
}

// FLAG: A personal-sale BLOCK needs explicit v3 policy and a pinned completed 9B answer.
// A 4B negative, an audit disagreement or an unavailable consultation authorizes no effect.
export function commercialLlmPolicyMayDeletePersonalSale(
  result: CommercialLlmObservationResult,
  source: CommercialLlmSource,
): boolean {
  if (
    source.version !== 3 ||
    !source.personalSaleBlocked ||
    result.classification !== 'NOT_COMMERCIAL' ||
    result.reasonCodes.length !== 1 ||
    result.reasonCodes[0] !== 'PERSONAL_SALE'
  )
    return false;
  const legacy = legacySourceForPolicy(source);
  if (
    !legacy ||
    !parseCommercialLlmDecision({
      classification: result.classification,
      reasonCodes: result.reasonCodes,
    })
  )
    return false;
  if (result.pool) {
    const pool = result.pool;
    if (
      legacy.version !== 2 ||
      !isCommercialLlmPoolNodeId(pool.nodeId) ||
      !commercialLlmPoolSourceAllowsNode(legacy, pool.nodeId)
    )
      return false;
    const profile = COMMERCIAL_LLM_POOL_PROFILES[pool.nodeId];
    const identity = profile.identity;
    if (
      profile.model !== '9b' ||
      pool.version !== 'commercial-pool-v2' ||
      pool.policy !== legacy.poolPolicy ||
      (pool.attempts !== 1 && pool.attempts !== 2) ||
      result.modelAlias !== identity.modelAlias ||
      result.modelSha256 !== identity.modelSha256 ||
      result.promptSha256 !== identity.promptSha256 ||
      result.chatTemplateSha256 !== identity.chatTemplateSha256 ||
      result.runtimeVersion !== identity.runtimeVersion ||
      result.runtimeImageSha256 !== identity.runtimeImageSha256 ||
      result.runtimeArtifactSha256 !== identity.runtimeArtifactSha256 ||
      result.runtimeSupportSha256 !== identity.runtimeSupportSha256 ||
      result.policyVersion !== COMMERCIAL_LLM_POLICY_VERSION
    )
      return false;
    if (pool.route === 'direct')
      return (
        pool.primaryNodeId === undefined &&
        pool.primaryClassification === undefined &&
        pool.consultationOutcome === undefined
      );
    return (
      pool.route === 'consulted' &&
      pool.primaryNodeId === 'pc-a-4b' &&
      pool.consultationOutcome === 'completed' &&
      (pool.primaryClassification === 'NOT_COMMERCIAL' || pool.primaryClassification === 'UNSURE')
    );
  }
  return (
    commercialLlmHasPinnedServerIdentity(result) &&
    result.cascade?.version === COMMERCIAL_LLM_CASCADE_VERSION &&
    result.cascade.primaryModelSha256 === COMMERCIAL_LLM_WORKSTATION_IDENTITY.modelSha256 &&
    ((result.cascade.route === 'secondary_audit' &&
      result.cascade.primaryClassification === 'NOT_COMMERCIAL') ||
      (result.cascade.route === 'secondary_unsure' &&
        result.cascade.primaryClassification === 'UNSURE') ||
      (result.cascade.route.startsWith('secondary_') &&
        result.cascade.primaryClassification === undefined))
  );
}
export function commercialLlmHasPinnedServerIdentity(
  result: CommercialLlmObservationResult,
): boolean {
  return (
    result.modelSha256 === COMMERCIAL_LLM_MODEL_SHA256 &&
    result.promptSha256 === COMMERCIAL_LLM_PROMPT_SHA256 &&
    result.runtimeImageSha256 === COMMERCIAL_LLM_RUNTIME_IMAGE_SHA256 &&
    result.chatTemplateSha256 === COMMERCIAL_LLM_CHAT_TEMPLATE_SHA256 &&
    result.policyVersion === COMMERCIAL_LLM_POLICY_VERSION
  );
}
