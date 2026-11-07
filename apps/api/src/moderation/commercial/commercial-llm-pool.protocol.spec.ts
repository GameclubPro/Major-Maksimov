import {
  COMMERCIAL_LLM_POOL_PROFILES,
  POOL_NODE_IDS,
  POOL_PENDING_KEYS,
  commercialLlmPoolIdentityMatches,
  commercialLlmPoolJobKey,
  commercialLlmPoolNodeKeys,
  commercialLlmPoolMinRemainingMs,
} from './commercial-llm-pool.protocol';
import {
  COMMERCIAL_LLM_MODEL_SHA256,
  COMMERCIAL_LLM_RUNTIME_IMAGE_SHA256,
} from './commercial-llm.protocol';
import {
  COMMERCIAL_LLM_WORKSTATION_IDENTITY,
  COMMERCIAL_LLM_WORKSTATION_KEYS,
} from './commercial-llm-workstation.protocol';

describe('commercial pool immutable node profiles', () => {
  it('distinguishes the real server Docker identity from the two GPU artifacts', () => {
    expect(COMMERCIAL_LLM_POOL_PROFILES['server-9b'].identity).toMatchObject({
      protocolVersion: 2,
      modelSha256: COMMERCIAL_LLM_MODEL_SHA256,
      runtimeImageSha256: COMMERCIAL_LLM_RUNTIME_IMAGE_SHA256,
    });
    expect(COMMERCIAL_LLM_POOL_PROFILES['pc-a-4b'].identity).toEqual({
      ...COMMERCIAL_LLM_WORKSTATION_IDENTITY,
      protocolVersion: 2,
    });
    expect(COMMERCIAL_LLM_POOL_PROFILES['pc-b-9b'].identity).toMatchObject({
      modelSha256: COMMERCIAL_LLM_MODEL_SHA256,
      runtimeArtifactSha256: COMMERCIAL_LLM_WORKSTATION_IDENTITY.runtimeArtifactSha256,
    });
    expect(COMMERCIAL_LLM_POOL_PROFILES['pc-b-9b'].identity.runtimeImageSha256).toBeUndefined();
  });

  it('gives the CPU bridge its own resources and CPU admission floor', () => {
    expect(COMMERCIAL_LLM_POOL_PROFILES['pc-a-cpu-9b']).toMatchObject({
      nodeId: 'pc-a-cpu-9b',
      model: '9b',
      transport: 'bridge',
      identity: {
        modelSha256: COMMERCIAL_LLM_MODEL_SHA256,
        runtimeArtifactSha256: COMMERCIAL_LLM_WORKSTATION_IDENTITY.runtimeArtifactSha256,
      },
    });
    expect(commercialLlmPoolMinRemainingMs('pc-a-cpu-9b')).toBe(18_000);
    expect(commercialLlmPoolMinRemainingMs('pc-b-9b')).toBe(0);
    expect(commercialLlmPoolNodeKeys('pc-a-cpu-9b')).not.toEqual(
      commercialLlmPoolNodeKeys('pc-a-4b'),
    );
  });

  it.each(POOL_NODE_IDS)('requires the complete exact profile for %s', (nodeId) => {
    const identity = COMMERCIAL_LLM_POOL_PROFILES[nodeId].identity;
    expect(commercialLlmPoolIdentityMatches(nodeId, identity)).toBe(true);
    expect(commercialLlmPoolIdentityMatches(nodeId, { ...identity, protocolVersion: 1 })).toBe(
      false,
    );
    expect(commercialLlmPoolIdentityMatches(nodeId, { ...identity, extra: true })).toBe(false);
    expect(commercialLlmPoolIdentityMatches(nodeId, { ...identity, modelSha256: 'foreign' })).toBe(
      false,
    );
    expect(commercialLlmPoolIdentityMatches(nodeId, null)).toBe(false);
  });

  it('keeps four node resources and pending inputs separate from the legacy singleton', () => {
    const keys = POOL_NODE_IDS.flatMap((id) => Object.values(commercialLlmPoolNodeKeys(id)));
    expect(new Set(keys).size).toBe(16);
    expect(
      keys.some((key) =>
        Object.values(COMMERCIAL_LLM_WORKSTATION_KEYS).some((legacy) => legacy === key),
      ),
    ).toBe(false);
    expect(POOL_PENDING_KEYS).toEqual([
      'commercial-llm-enforcement:pool-v2:slot',
      'commercial-llm-enforcement:pool-v2:slot-next',
    ]);
    expect(() => commercialLlmPoolJobKey('unbounded:key')).toThrow('pool_job_refused');
  });
});
