import { readOutcomeCohortSource } from './outcome-cohort-online-targets.mjs';

export const ROUTING_INDEX_TARGET = Object.freeze({
  selector: 'routing',
  migration: '20261103120000_index_webhook_chat_queue_head',
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
  if (address.searchParams.has('options'))
    throw new Error('ROUTING_INDEX_DATABASE_OPTIONS_BLOCKED');
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
