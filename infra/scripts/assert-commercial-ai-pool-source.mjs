import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const COMMERCIAL_AI_POOL_SOURCE_PATHS = Object.freeze({
  protocol: 'apps/api/src/moderation/commercial/commercial-llm-enforcement.protocol.ts',
  profiles: 'apps/api/src/moderation/commercial/commercial-llm-pool.protocol.ts',
  guard: 'apps/api/src/moderation/commercial/commercial-llm-delete-guard.service.ts',
});

function executable(source) {
  if (typeof source !== 'string' || source.length > 2 * 1024 * 1024)
    throw new Error('Commercial AI pool source exceeds the reader budget');
  return source.replace(
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/gu,
    (match, literal) => literal ?? '',
  );
}

function compact(source) {
  return source.replace(/\s+/gu, '').replace(/,(?=[)\]}])/gu, '');
}

function body(source, name, indent = '') {
  const pattern = new RegExp(
    `^${indent}(?:export )?(?:private )?(?:async )?(?:function )?${name}\\s*\\(`,
    'gmu',
  );
  const starts = [...source.matchAll(pattern)];
  if (starts.length !== 1) return '';
  const open = source.indexOf('{', starts[0].index);
  const end = source.indexOf(`\n${indent}}`, open);
  return open >= 0 && end > open ? compact(source.slice(open + 1, end)) : '';
}

function frozenObject(source, name) {
  const pattern = new RegExp(
    `^export const ${name}\\b[\\s\\S]*?Object\\.freeze\\(\\{([\\s\\S]*?)^\\}\\);`,
    'gmu',
  );
  const matches = [...source.matchAll(pattern)];
  return matches.length === 1 ? compact(matches[0][1]) : '';
}

function requireFact(value, detail) {
  if (!value)
    throw new Error(`Rollback target lacks the commercial AI four-node source reader: ${detail}`);
}

// FLAG: Retained three-node proofs must remain readable without gaining the fourth node.
// Verify executable generation checks and final proof use; a version marker is insufficient.
export function assertCommercialAiPoolSource(readSource) {
  const protocol = executable(readSource(COMMERCIAL_AI_POOL_SOURCE_PATHS.protocol));
  const profiles = executable(readSource(COMMERCIAL_AI_POOL_SOURCE_PATHS.profiles));
  const guard = executable(readSource(COMMERCIAL_AI_POOL_SOURCE_PATHS.guard));
  const protocolCode = compact(protocol);
  const profilesCode = compact(profiles);
  requireFact(
    protocolCode.includes('exportconstCOMMERCIAL_LLM_POOL_FOUR_NODE_READER_VERSION=1;') &&
      protocolCode.includes('exportconstCOMMERCIAL_LLM_ENFORCEMENT_VERSION=1;'),
    'legacy and fourth-node reader versions',
  );
  for (const [name, identity] of [
    [
      'legacyCommercialLlmPoolEnforcementIdentity',
      "['commercial-pool-v2',LEGACY_COMMERCIAL_LLM_POOL_PROFILES,policy]",
    ],
    [
      'commercialLlmPoolEnforcementIdentity',
      "['commercial-pool-v2',COMMERCIAL_LLM_POOL_PROFILES,policy]",
    ],
    [
      'legacyCommercialLlmPolicyEnforcementIdentity',
      "['commercial-category-policy-v1',legacyCommercialLlmPoolEnforcementIdentity(policy)]",
    ],
  ])
    requireFact(
      body(protocol, name) ===
        `returncreateHash('sha256').update(JSON.stringify(${identity})).digest('hex');`,
      `${name} binds the original profile generation`,
    );
  requireFact(
    body(protocol, 'commercialLlmPolicyEnforcementIdentity') ===
      compact(`
      return createHash('sha256').update(JSON.stringify([
        'commercial-category-policy-v1',
        policy ? commercialLlmPoolEnforcementIdentity(policy) : COMMERCIAL_LLM_ENFORCEMENT_IDENTITY_SHA256,
      ])).digest('hex');
    `),
    'current category-policy identity',
  );

  const schemas = [
    ...protocol.matchAll(
      /^export const commercialLlmSourceSchema\s*=\s*z\.union\(\[([\s\S]*?)^\]\);/gmu,
    ),
  ];
  const schema = schemas.length === 1 ? compact(schemas[0][1]) : '';
  requireFact(schema.startsWith('legacyCommercialLlmSourceSchema,'), 'legacy version-1 schema');
  for (const policy of ['confirm-positive', 'direct-4b'])
    requireFact(
      schema.includes(
        compact(`legacyCommercialLlmSourceSchema.extend({
        version: z.literal(2),
        classifierSha256: z.union([
          z.literal(commercialLlmPoolEnforcementIdentity('${policy}')),
          z.literal(legacyCommercialLlmPoolEnforcementIdentity('${policy}')),
        ]),
        poolPolicy: z.literal('${policy}'),
      })`),
      ),
      `version-2 ${policy} parses both profile generations`,
    );
  requireFact(
    schema.includes(
      compact(`...(['confirm-positive', 'direct-4b'] as const).map((policy) =>
      legacyCommercialLlmSourceSchema.extend({
        version: z.literal(3),
        classifierSha256: z.union([
          z.literal(commercialLlmPolicyEnforcementIdentity(policy)),
          z.literal(legacyCommercialLlmPolicyEnforcementIdentity(policy)),
        ]),
        poolPolicy: z.literal(policy),
        personalSaleBlocked: z.boolean(),
      }),
    )`),
    ),
    'version-3 policy schema parses both profile generations',
  );

  requireFact(
    profilesCode.includes(
      "exportconstLEGACY_POOL_NODE_IDS=['server-9b','pc-a-4b','pc-b-9b']asconst;",
    ) &&
      profilesCode.includes(
        "exportconstPOOL_NODE_IDS=[...LEGACY_POOL_NODE_IDS,'pc-a-cpu-9b']asconst;",
      ),
    'separate three-node and four-node capabilities',
  );
  requireFact(
    frozenObject(profiles, 'LEGACY_COMMERCIAL_LLM_POOL_PROFILES') ===
      compact(`
      'server-9b': Object.freeze({ nodeId: 'server-9b', model: '9b', transport: 'http', identity: serverIdentity }),
      'pc-a-4b': Object.freeze({ nodeId: 'pc-a-4b', model: '4b', transport: 'bridge', identity: pc4bIdentity }),
      'pc-b-9b': Object.freeze({ nodeId: 'pc-b-9b', model: '9b', transport: 'bridge', identity: pc9bIdentity }),
    `) &&
      frozenObject(profiles, 'COMMERCIAL_LLM_POOL_PROFILES') ===
        compact(`
        ...LEGACY_COMMERCIAL_LLM_POOL_PROFILES,
        'pc-a-cpu-9b': Object.freeze({ nodeId: 'pc-a-cpu-9b', model: '9b', transport: 'bridge', identity: pcCpu9bIdentity }),
      `),
    'immutable original profile order and separate fourth profile',
  );
  requireFact(
    body(profiles, 'isCommercialLlmPoolNodeId') ===
      "returntypeofvalue==='string'&&POOL_NODE_IDS.some((nodeId)=>nodeId===value);",
    'known-node validation uses the four-node capability list',
  );
  requireFact(
    body(protocol, 'commercialLlmPoolSourceAllowsNode') ===
      compact(`
      if (!('poolPolicy' in source) || !isCommercialLlmPoolNodeId(nodeId)) return false;
      const policy = source.poolPolicy;
      if (source.version !== 2 && source.version !== 3) return false;
      const currentIdentity = source.version === 2
        ? commercialLlmPoolEnforcementIdentity(policy) : commercialLlmPolicyEnforcementIdentity(policy);
      if (source.classifierSha256 === currentIdentity) return true;
      const legacyIdentity = source.version === 2
        ? legacyCommercialLlmPoolEnforcementIdentity(policy) : legacyCommercialLlmPolicyEnforcementIdentity(policy);
      return (
        source.classifierSha256 === legacyIdentity &&
        LEGACY_POOL_NODE_IDS.some((legacyNodeId) => legacyNodeId === nodeId)
      );
    `),
    'legacy source capability cannot expand to the fourth node',
  );
  requireFact(
    body(protocol, 'legacySourceForPolicy') ===
      compact(`
      if (source.version !== 3) return null;
      const policy = 'poolPolicy' in source ? source.poolPolicy : undefined;
      const legacyPool = policy !== undefined &&
        source.classifierSha256 === legacyCommercialLlmPolicyEnforcementIdentity(policy);
      if (!legacyPool && source.classifierSha256 !== commercialLlmPolicyEnforcementIdentity(policy)) return null;
      const base: Partial<typeof source> = { ...source };
      delete base.personalSaleBlocked;
      return commercialLlmSourceSchema.parse({
        ...base,
        version: policy ? 2 : 1,
        classifierSha256: policy
          ? legacyPool ? legacyCommercialLlmPoolEnforcementIdentity(policy) : commercialLlmPoolEnforcementIdentity(policy)
          : COMMERCIAL_LLM_ENFORCEMENT_IDENTITY_SHA256,
      });
    `),
    'version-3 conversion preserves its original profile generation',
  );
  requireFact(
    body(protocol, 'commercialLlmMayDelete').startsWith(
      compact(`
      if (source?.version === 3) {
        const legacy = legacySourceForPolicy(source);
        return legacy !== null && commercialLlmMayDelete(result, legacy);
      }
      if (source?.version === 2 || result.pool) return poolMayDelete(result, source);
    `),
    ),
    'ordinary deletion dispatches through the generation-aware pool guard',
  );
  const pool = body(protocol, 'poolMayDelete');
  requireFact(
    pool.startsWith(
      compact(`
      const pool = result.pool;
      if (
        source?.version !== 2 || !pool || pool.version !== 'commercial-pool-v2' ||
        pool.policy !== source.poolPolicy || !isCommercialLlmPoolNodeId(pool.nodeId) ||
        (pool.attempts !== 1 && pool.attempts !== 2) ||
        !commercialLlmPoolSourceAllowsNode(source, pool.nodeId) ||
        parseCommercialLlmDecision({ classification: result.classification, reasonCodes: result.reasonCodes })?.classification !== 'COMMERCIAL'
      ) return false;
      const profile = COMMERCIAL_LLM_POOL_PROFILES[pool.nodeId];
      const identity = profile.identity;
    `),
    ),
    'ordinary pool result checks original generation before profile lookup',
  );
  for (const field of [
    'modelAlias',
    'modelSha256',
    'promptSha256',
    'chatTemplateSha256',
    'runtimeVersion',
    'runtimeImageSha256',
    'runtimeArtifactSha256',
    'runtimeSupportSha256',
  ])
    requireFact(
      pool.includes(`result.${field}!==identity.${field}||`),
      `pinned ${field} result proof`,
    );
  const personal = body(protocol, 'commercialLlmPolicyMayDeletePersonalSale');
  requireFact(
    personal.includes(
      compact(`
      if (result.pool) {
        const pool = result.pool;
        if (legacy.version !== 2 || !isCommercialLlmPoolNodeId(pool.nodeId) ||
          !commercialLlmPoolSourceAllowsNode(legacy, pool.nodeId)) return false;
        const profile = COMMERCIAL_LLM_POOL_PROFILES[pool.nodeId];
        const identity = profile.identity;
    `),
    ),
    'personal-sale proof retains the original generation check',
  );
  requireFact(
    body(guard, 'currentSettings', '  ').includes(
      compact(`
      if (
        fingerprintCommercialDeleteSettings(settings) !== source.settingsSha256 ||
        !(await this.admission.hasProof(source)) || !this.admission.enabled() ||
        !commercialLlmSourceCurrent(source)
      ) reject();
      return settings;
    `),
    ),
    'final current-settings guard rejects a missing exact-source proof',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== '--stdin')
      throw new Error('Expected bounded commercial AI source input');
    const input = readFileSync(0);
    if (input.length > 6 * 1024 * 1024)
      throw new Error('Commercial AI source input exceeds budget');
    const sources = input.toString('utf8').split('\0');
    if (sources.length !== 4 || sources.pop() !== '')
      throw new Error('Expected three exact commercial AI source files');
    const paths = Object.values(COMMERCIAL_AI_POOL_SOURCE_PATHS);
    assertCommercialAiPoolSource((path) => sources[paths.indexOf(path)]);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
