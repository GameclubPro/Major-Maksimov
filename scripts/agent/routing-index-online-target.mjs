import { readOutcomeCohortSource } from './outcome-cohort-online-targets.mjs';

export const ROUTING_INDEX_TARGET = Object.freeze({
  selector: 'routing',
  migration: '20261118120000_index_webhook_chat_queue_head',
  checksum: 'c978fd08b956288ee7fe57008a148b775cfcd418fdbfa1238caef7746dc514a7',
  index: 'webhook_events_chat_queue_head_idx',
  table: 'webhook_events',
  statementMs: 2_700_000,
  tableCeilingBytes: 160 * 1024 ** 3,
  tempBytes: 8 * 1024 ** 3,
  estimateBytesPerRow: 256,
});

export function verifyRoutingIndexDatabaseUrl(value) {
  let address;
  try {
    address = new URL(value);
  } catch {
    throw new Error('ROUTING_INDEX_DATABASE_URL_INVALID');
  }
  const supported = new Set([
    'schema',
    'connection_limit',
    'pool_timeout',
    'connect_timeout',
    'sslmode',
  ]);
  const seen = new Set();
  for (const [key, option] of address.searchParams) {
    // FLAG: pg accepts URI query overrides such as port and user. Only use the authority
    // validated against Compose so that the client builds on the store inspected by psql.
    if (!supported.has(key) || seen.has(key) || (key === 'schema' && option !== 'public'))
      throw new Error('ROUTING_INDEX_DATABASE_OPTIONS_BLOCKED');
    seen.add(key);
  }
  return value;
}

export function readRoutingIndexSource(root) {
  const source = readOutcomeCohortSource(root);
  if (
    source.find((entry) => entry.name === ROUTING_INDEX_TARGET.migration)?.checksum !==
    ROUTING_INDEX_TARGET.checksum
  )
    throw new Error('ROUTING_INDEX_SOURCE_CHECKSUM_MISMATCH');
  return source;
}
