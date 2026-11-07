import { ConfigService } from '@nestjs/config';
import {
  buildCommercialLlmOffer,
  commercialLlmMayDelete,
  commercialLlmSourceKey,
  commercialLlmSourceSchema,
  commercialLlmPolicyMayDeletePersonalSale,
  commercialLlmPolicyEnforcementIdentity,
  commercialLlmPoolEnforcementIdentity,
  commercialLlmPoolSourceAllowsNode,
  legacyCommercialLlmPolicyEnforcementIdentity,
  legacyCommercialLlmPoolEnforcementIdentity,
  type CommercialLlmPoolPolicy,
} from './commercial-llm-enforcement.protocol';
import { CommercialLlmEnforcementService } from './commercial-llm-enforcement.service';
import { CommercialLlmEnforcementMailbox } from './commercial-llm-enforcement.mailbox';
import {
  COMMERCIAL_LLM_POOL_PROFILES,
  type CommercialLlmPoolNodeId,
} from './commercial-llm-pool.protocol';
import {
  COMMERCIAL_LLM_POLICY_VERSION,
  type CommercialLlmObservationResult,
} from './commercial-llm.protocol';
import { createCommercialLlmRedis } from './commercial-llm-shadow.lease';

function source(policy?: CommercialLlmPoolPolicy) {
  const now = Date.now();
  return buildCommercialLlmOffer(
    {
      chatId: 'chat',
      messageId: 'message',
      userId: 'author',
      originBotId: 'bot',
      text: 'Мастерская принимает заказы на ремонт.',
      eventAt: new Date(now).toISOString(),
      origin: {
        sourceWebhookEventId: 'receipt',
        sourceReceivingBotId: 'bot',
        sourceExecutionBotId: 'bot',
        sourceEventAtMs: now,
        sourceEvidenceVersion: 1,
      },
      settings: {
        commercialAdsFilterEnabled: true,
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 45,
        commercialAdsDeleteThreshold: 65,
        nightModeTimezone: 'Europe/Moscow',
        textFiltersWarnEnabled: true,
        textFiltersMuteEnabled: true,
        textFiltersBanEnabled: true,
        textFiltersMuteDurationHours: 1,
        textFiltersBotMessageEnabled: true,
      },
    },
    now,
    policy,
  )!.source;
}
function positive(
  nodeId: CommercialLlmPoolNodeId,
  policy: CommercialLlmPoolPolicy,
): CommercialLlmObservationResult {
  return {
    ...COMMERCIAL_LLM_POOL_PROFILES[nodeId].identity,
    classification: 'COMMERCIAL',
    reasonCodes: ['COMMERCIAL_OFFER'],
    durationMs: 10,
    policyVersion: COMMERCIAL_LLM_POLICY_VERSION,
    pool: { version: 'commercial-pool-v2', nodeId, policy, route: 'direct', attempts: 1 },
  };
}

describe('commercial pool DELETE authority', () => {
  afterEach(() => jest.restoreAllMocks());
  it('preserves v1 serialized proofs and rejects mutated v2 policy identities', () => {
    const legacy = source();
    expect(legacy.version).toBe(1);
    expect(Object.keys(legacy)).toEqual([
      'version',
      'classifierSha256',
      'origin',
      'nonce',
      'chatId',
      'messageId',
      'userId',
      'originBotId',
      'eventAtMs',
      'deadlineAtMs',
      'sourceSha256',
      'settingsSha256',
    ]);
    expect(
      commercialLlmSourceKey(commercialLlmSourceSchema.parse(JSON.parse(JSON.stringify(legacy)))),
    ).toBe(commercialLlmSourceKey(legacy));
    const pool = source('confirm-positive');
    expect(pool.version).toBe(2);
    expect(commercialLlmSourceSchema.safeParse({ ...pool, poolPolicy: 'direct-4b' }).success).toBe(
      false,
    );
    expect(commercialLlmSourceSchema.safeParse({ ...pool, extra: true }).success).toBe(false);
  });
  it.each(['server-9b', 'pc-b-9b', 'pc-a-cpu-9b'] as const)(
    'accepts exact direct9B provenance from %s only for its v2 source',
    (nodeId) => {
      const result = positive(nodeId, 'confirm-positive');
      expect(commercialLlmMayDelete(result, source('confirm-positive'))).toBe(true);
      expect(commercialLlmMayDelete(result, source())).toBe(false);
      expect(commercialLlmMayDelete(result)).toBe(false);
      for (const key of [
        'modelAlias',
        'modelSha256',
        'promptSha256',
        'chatTemplateSha256',
        'runtimeVersion',
        'runtimeImageSha256',
        'runtimeArtifactSha256',
        'runtimeSupportSha256',
        'policyVersion',
      ] as const)
        expect(
          commercialLlmMayDelete({ ...result, [key]: 'tampered' }, source('confirm-positive')),
        ).toBe(false);
    },
  );
  it.each([
    {
      policy: 'confirm-positive' as const,
      pool: '1557d284906f33d5ede2e03c62a6768260920693470324f7d7352eaa1548c0ad',
      category: '5019d90c33288bb6b8f24a571b196306729b56470e6fad80da60bb34cf5356f0',
    },
    {
      policy: 'direct-4b' as const,
      pool: '4339ed5a3ec1f4dc241af66c8fad0d67d2fb9acfea7cecf6ef95c8040a9abe29',
      category: 'f8ddb9860a60b028c2e91b6844c69c54e91781df2e095e3954862233bd8e38a8',
    },
  ])(
    'reads retained $policy sources without granting the CPU bridge legacy authority',
    ({ policy, pool, category }) => {
      // Golden digests come from the pre-fourth-node 99c07156 source serialization.
      expect(legacyCommercialLlmPoolEnforcementIdentity(policy)).toBe(pool);
      expect(legacyCommercialLlmPolicyEnforcementIdentity(policy)).toBe(category);
      expect(commercialLlmPoolEnforcementIdentity(policy)).not.toBe(pool);
      for (const version of [2, 3] as const) {
        const old = commercialLlmSourceSchema.parse({
          ...source(policy),
          version,
          classifierSha256: version === 2 ? pool : category,
          ...(version === 3 ? { personalSaleBlocked: true } : {}),
        });
        const roundtrip = commercialLlmSourceSchema.parse(JSON.parse(JSON.stringify(old)));
        expect(commercialLlmSourceKey(roundtrip)).toBe(commercialLlmSourceKey(old));
        expect(commercialLlmPoolSourceAllowsNode(old, 'pc-b-9b')).toBe(true);
        expect(commercialLlmPoolSourceAllowsNode(old, 'pc-a-cpu-9b')).toBe(false);
        expect(commercialLlmMayDelete(positive('pc-b-9b', policy), old)).toBe(true);
        expect(commercialLlmMayDelete(positive('pc-a-cpu-9b', policy), old)).toBe(false);
        const current = commercialLlmSourceSchema.parse({
          ...old,
          classifierSha256:
            version === 2
              ? commercialLlmPoolEnforcementIdentity(policy)
              : commercialLlmPolicyEnforcementIdentity(policy),
        });
        expect(commercialLlmPoolSourceAllowsNode(current, 'pc-a-cpu-9b')).toBe(true);
        expect(commercialLlmMayDelete(positive('pc-a-cpu-9b', policy), current)).toBe(true);
        expect(
          commercialLlmSourceSchema.safeParse({ ...old, classifierSha256: 'f'.repeat(64) }).success,
        ).toBe(false);
        if (version === 3) {
          const personal = {
            ...positive('pc-a-cpu-9b', policy),
            classification: 'NOT_COMMERCIAL' as const,
            reasonCodes: ['PERSONAL_SALE' as const],
          };
          expect(commercialLlmPolicyMayDeletePersonalSale(personal, old)).toBe(false);
          expect(commercialLlmPolicyMayDeletePersonalSale(personal, current)).toBe(true);
          expect(
            commercialLlmPolicyMayDeletePersonalSale(
              { ...personal, runtimeArtifactSha256: 'tampered' },
              current,
            ),
          ).toBe(false);
          const legacyPersonal = {
            ...positive('pc-b-9b', policy),
            classification: 'NOT_COMMERCIAL' as const,
            reasonCodes: ['PERSONAL_SALE' as const],
          };
          expect(commercialLlmPolicyMayDeletePersonalSale(legacyPersonal, old)).toBe(true);
        }
      }
    },
  );

  it('requires explicit direct4B authority and completed idle9B confirmation under conservative policy', () => {
    expect(
      commercialLlmMayDelete(positive('pc-a-4b', 'confirm-positive'), source('confirm-positive')),
    ).toBe(false);
    expect(commercialLlmMayDelete(positive('pc-a-4b', 'direct-4b'), source('direct-4b'))).toBe(
      true,
    );
    const result = positive('pc-b-9b', 'confirm-positive');
    result.pool = {
      ...result.pool!,
      route: 'consulted',
      primaryNodeId: 'pc-a-4b',
      primaryClassification: 'COMMERCIAL',
      consultationOutcome: 'completed',
    };
    expect(commercialLlmMayDelete(result, source('confirm-positive'))).toBe(true);
    for (const outcome of ['no_capacity', 'budget_exhausted'] as const)
      expect(
        commercialLlmMayDelete(
          { ...result, pool: { ...result.pool, consultationOutcome: outcome } },
          source('confirm-positive'),
        ),
      ).toBe(false);
    expect(
      commercialLlmMayDelete(
        { ...result, pool: { ...result.pool, primaryClassification: 'NOT_COMMERCIAL' } },
        source('confirm-positive'),
      ),
    ).toBe(false);
  });
  it('revokes retained v2 proofs immediately when routing is disabled or 4B policy changes', async () => {
    const config = new ConfigService({
      COMMERCIAL_LLM_ENFORCEMENT_ENABLED: true,
      COMMERCIAL_LLM_POOL_WORKERS_ENABLED: true,
      COMMERCIAL_LLM_POOL_ENABLED: true,
      COMMERCIAL_LLM_POOL_4B_POLICY: 'confirm-positive',
    });
    const service = new CommercialLlmEnforcementService(config);
    const redis = createCommercialLlmRedis('redis://127.0.0.1:1');
    const mailbox = new CommercialLlmEnforcementMailbox(redis);
    const proof = jest.spyOn(mailbox, 'hasProof').mockResolvedValue(true);
    jest.spyOn(service, 'mailbox').mockResolvedValue(mailbox);
    const original = source('confirm-positive');
    expect(await service.hasProof(original)).toBe(true);
    config.set('COMMERCIAL_LLM_POOL_4B_POLICY', 'direct-4b');
    expect(await service.hasProof(original)).toBe(false);
    config.set('COMMERCIAL_LLM_POOL_ENABLED', false);
    expect(await service.hasProof(source('direct-4b'))).toBe(false);
    expect(await service.hasProof(source())).toBe(true);
    expect(proof).toHaveBeenCalledTimes(2);
    redis.disconnect();
  });
});
