import { parseArgs } from 'node:util';
import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';

const sources = [
  'registry',
  'candidates',
  'chats',
  'archives',
  'observations',
  'profiles',
] as const;
type Source = (typeof sources)[number];
type ResultRow = { a: string; b: string; retired: string; copy: boolean | null };

function parseCursor(source: Source, token?: string): [string, string] {
  if (!token) return ['', ''];
  if (token.length > 4096 || !/^[a-zA-Z0-9_-]+$/u.test(token)) throw new Error('Invalid cursor');
  const row: unknown = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  if (
    !Array.isArray(row) ||
    row.length !== 3 ||
    row[0] !== source ||
    row
      .slice(1)
      .some((value) => typeof value !== 'string' || value.includes('\0') || value.length > 1024)
  )
    throw new Error('Cursor belongs to a different source or is malformed');
  return [row[1], row[2]];
}

const descriptors = {
  registry: { table: 'global_spammers', key: 'user_id' },
  candidates: { table: 'global_spammer_candidates', key: 'user_id' },
  chats: { table: 'global_spammer_candidate_chats', key: 'candidate_user_id' },
  archives: { table: 'global_spammer_archives', key: 'id' },
  observations: { table: 'spammer_observations', key: 'id' },
  profiles: { table: 'spammer_user_runtime_profiles', key: 'user_id' },
} as const;

export async function previewRetiredSpammerData(
  db: PrismaClient,
  input: { source: string; limit: number; cursor?: string },
) {
  if (
    !sources.includes(input.source as Source) ||
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  )
    throw new Error(
      'Expected --source registry|candidates|chats|archives|observations|profiles and --limit 1..100',
    );
  const source = input.source as Source;
  const [afterA, afterB] = parseCursor(source, input.cursor);
  const descriptor = descriptors[source];
  // FLAG: Identifiers are selected from the fixed descriptors. Page by the primary key before classifying JSON.
  const key = Prisma.raw(descriptor.key);
  const table = Prisma.raw(descriptor.table);
  const second = source === 'chats' ? Prisma.sql`chat_id` : Prisma.sql`''::text`;
  const predicate =
    source === 'chats'
      ? Prisma.sql`(${key}, chat_id) > (${afterA},${afterB})`
      : Prisma.sql`${key} > ${afterA}`;
  const order = source === 'chats' ? Prisma.sql`${key}, chat_id` : key;
  const breakdown =
    source === 'chats' || source === 'observations'
      ? Prisma.sql`NULL::jsonb`
      : Prisma.sql`source_breakdown`;
  const retired =
    source === 'observations'
      ? Prisma.sql`CASE WHEN source='DEVELOPER_FORCED' THEN 'only' ELSE 'none' END`
      : Prisma.sql`CASE WHEN pg_column_size(breakdown)>65536 THEN 'unmeasured'
      WHEN jsonb_typeof(breakdown)='object' AND breakdown ? 'DEVELOPER_FORCED'
      THEN CASE WHEN breakdown - 'DEVELOPER_FORCED' = '{}'::jsonb THEN 'only' ELSE 'mixed' END ELSE 'none' END`;
  const data =
    source === 'profiles'
      ? Prisma.sql`NULL::jsonb`
      : source === 'observations'
        ? Prisma.sql`evidence`
        : Prisma.sql`last_evidence`;
  const extras =
    source === 'observations'
      ? Prisma.sql`source, normalized_features AS features`
      : Prisma.sql`NULL::text AS source, NULL::jsonb AS features`;
  const excerpt = source === 'chats' ? Prisma.sql`last_excerpt IS NOT NULL` : Prisma.sql`false`;
  const projection = Prisma.sql`WITH page AS MATERIALIZED (SELECT ${key} AS a, ${second} AS b, ${breakdown} AS breakdown,
    ${data} AS evidence, ${extras}, ${excerpt} AS excerpt FROM ${table} WHERE ${predicate} ORDER BY ${order} LIMIT ${input.limit + 1})
    SELECT a,b, ${retired} AS retired, CASE WHEN excerpt THEN true
      WHEN pg_column_size(evidence)>65536 OR pg_column_size(features)>65536 THEN NULL
      ELSE COALESCE(evidence ?| ARRAY['text','messageText','excerpt','urls','metadata','actorUserId'],false)
        OR COALESCE(jsonb_typeof(evidence->'evidence') NOT IN ('null'),false)
        OR COALESCE(features ? 'urls',false) END AS copy FROM page ORDER BY a,b`;
  const rows = await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '1500ms'`;
      return tx.$queryRaw<ResultRow[]>(projection);
    },
    { timeout: 3000 },
  );
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > input.limit && last
      ? Buffer.from(JSON.stringify([source, last.a, last.b])).toString('base64url')
      : null;
  return {
    source,
    scanned: page.length,
    retiredOnly: page.filter((row) => row.retired === 'only').length,
    retiredMixed: page.filter((row) => row.retired === 'mixed').length,
    provenanceUnmeasured: page.filter((row) => row.retired === 'unmeasured').length,
    rowsWithRawCopyIndicators: page.filter((row) => row.copy === true).length,
    copyUnmeasured: page.filter((row) => row.copy === null).length,
    nextCursor,
  };
}

async function main() {
  const { values } = parseArgs({
    options: { source: { type: 'string' }, limit: { type: 'string' }, cursor: { type: 'string' } },
  });
  const db = createPrismaClient();
  try {
    const result = await previewRetiredSpammerData(db, {
      source: values.source ?? 'registry',
      limit: Number(values.limit ?? '25'),
      cursor: values.cursor,
    });
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally {
    await db.$disconnect();
  }
}

if (require.main === module)
  void main().catch((error: unknown) => {
    process.stderr.write((error instanceof Error ? error.message : 'Preview failed') + '\n');
    process.exitCode = 1;
  });
