export const GLOBAL_SPAMMER_OBSERVATION_SOURCES = [
  'FANOUT_HIGH',
  'FANOUT_REPEAT',
  'COMMERCIAL_AD',
  'COMMERCIAL_CAMPAIGN',
  'REPEATED_LINK',
  'REPEATED_PHONE',
  'GRAPH_DOMAIN',
  'GRAPH_PHONE',
  'GRAPH_TEXT',
  'GRAPH_CAMPAIGN',
  'GRAPH_FANOUT_PATTERN',
  'SANCTION_BAN',
  'MANUAL_BAN',
  'LOCAL_ADMIN_BLOCK',
  'LOCAL_ADMIN_ALLOW',
  'REVIEW_APPROVED',
] as const;

export type GlobalSpammerObservationSource = (typeof GLOBAL_SPAMMER_OBSERVATION_SOURCES)[number];
const activeSources = new Set<string>(GLOBAL_SPAMMER_OBSERVATION_SOURCES);

export function isActiveObservationSource(value: unknown): value is GlobalSpammerObservationSource {
  return typeof value === 'string' && activeSources.has(value);
}

export function hasActiveRegistryProvenance(sourceBreakdown: unknown): boolean {
  // FLAG: Persisted mixed or unrecognized sources cannot authorize a sanction after retirement.
  if (!sourceBreakdown || typeof sourceBreakdown !== 'object' || Array.isArray(sourceBreakdown))
    return false;
  const sources = Object.keys(sourceBreakdown);
  return sources.length > 0 && sources.every(isActiveObservationSource);
}
