import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  OUTCOME_COHORT_TARGETS,
  readOutcomeCohortSource,
} from '../../scripts/agent/outcome-cohort-online-targets.mjs';
import {
  historicalCompatibilityCtes,
  historicalCompatibilityProjection,
} from '../../scripts/agent/outcome-cohort-historical-compatibility.mjs';
import { validateOnlineMigrationReceipts } from './online-migration-receipts.mjs';

const fail = (code) => {
  throw new Error(`OUTCOME_COHORT_${code}`);
};
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
export const OUTCOME_COHORT_RECEIPT_LIMIT = 4096;

// FLAG: The metadata size guard precedes receipt access in the same readonly snapshot.
// No application history, arbitrary logs, operator SQL or repair command is read here.
export const outcomeCohortStateSql = `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '2500ms';
SET LOCAL lock_timeout = '250ms';
SET LOCAL max_parallel_workers_per_gather = 0;
DO $guard$ BEGIN
  IF to_regclass('public._prisma_migrations') IS NULL
    OR pg_total_relation_size('public._prisma_migrations') > 8388608 THEN
    RAISE EXCEPTION 'OUTCOME_COHORT_RECEIPT_METADATA_UNAVAILABLE';
  END IF;
END $guard$;
WITH expected(selector, table_name, index_name, keys) AS (VALUES
${OUTCOME_COHORT_TARGETS.map((t) => `(${quote(t.selector)},${quote(t.table)},${quote(t.index)},ARRAY[${t.keys.map(quote)}])`).join(',\n')}
), definitions AS MATERIALIZED (
  SELECT expected.selector, relation.oid IS NOT NULL AS present,
    COALESCE(state.indisvalid,false) AS valid, COALESCE(state.indisready,false) AS ready,
    COALESCE(state.indislive,false) AS live,
    COALESCE(relation.relkind = 'i' AND relation.relpersistence = 'p'
      AND relation.reltablespace = 0 AND relation.reloptions IS NULL
      AND parent.relkind = 'r' AND parent.relpersistence = 'p'
      AND parent.reltablespace = 0 AND NOT parent.relhassubclass AND NOT parent.relispartition
      AND NOT EXISTS (SELECT 1 FROM pg_inherits inheritance
        WHERE inheritance.inhrelid=parent.oid OR inheritance.inhparent=parent.oid)
      AND state.indrelid = parent.oid AND method.amname = 'btree'
      AND NOT state.indisunique AND NOT state.indisprimary AND NOT state.indisexclusion
      AND state.indimmediate
      AND state.indexprs IS NULL AND state.indpred IS NULL
      AND state.indnkeyatts = cardinality(expected.keys)
      AND state.indnatts = cardinality(expected.keys)
      AND 0 = ALL(state.indoption::smallint[])
      AND ARRAY(SELECT pg_get_indexdef(relation.oid, k, false)
        FROM generate_series(1, cardinality(expected.keys)) k ORDER BY k) =
        ARRAY(SELECT quote_ident(key) FROM unnest(expected.keys) key)
      AND NOT EXISTS (SELECT 1 FROM unnest(state.indclass::oid[]) binding
        JOIN pg_opclass definition ON definition.oid = binding
        WHERE NOT definition.opcdefault OR definition.opcnamespace <> 'pg_catalog'::regnamespace)
      AND NOT EXISTS (SELECT 1 FROM unnest(state.indcollation::oid[], expected.keys) binding(actual_oid, name)
        JOIN pg_attribute attribute ON attribute.attrelid = state.indrelid AND attribute.attname = binding.name
        WHERE binding.actual_oid <> attribute.attcollation), false) AS definition_matches
  FROM expected
  LEFT JOIN pg_class parent ON parent.oid = to_regclass('public.' || expected.table_name)
  LEFT JOIN pg_class relation ON relation.oid = to_regclass('public.' || expected.index_name)
  LEFT JOIN pg_index state ON state.indexrelid = relation.oid
  LEFT JOIN pg_am method ON method.oid = relation.relam
), inspected AS MATERIALIZED (
  SELECT *, definition_matches AND valid AND ready AND live AS exact FROM definitions
), receipts AS MATERIALIZED (
  SELECT id, migration_name AS name, checksum, started_at AS started_at,
    finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back,
    applied_steps_count AS steps, CASE
      WHEN logs IS NULL THEN NULL
      WHEN logs LIKE '%57014%' OR logs LIKE '%canceling statement%' THEN 'canceled'
      WHEN logs LIKE '%55P03%' OR logs LIKE '%lock timeout%' THEN 'lock_timeout'
      ELSE 'migration_failure' END AS failure_family
  FROM public._prisma_migrations LIMIT ${OUTCOME_COHORT_RECEIPT_LIMIT + 1}
), artifacts AS MATERIALIZED (
  SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND EXISTS (SELECT 1 FROM expected
    WHERE left(c.relname, least(length(expected.index_name), 52)) = left(expected.index_name, 52)
      AND c.relname ~ '_cc(new|old)[0-9]*$') LIMIT 17
), builders AS MATERIALIZED (
  SELECT expected.selector, progress.pid,
    CASE WHEN activity.application_name ~ '^maxim-online-[a-f0-9-]{36}$'
      THEN activity.application_name ELSE NULL END AS application_name
  FROM pg_stat_progress_create_index progress
  JOIN expected ON progress.relid=to_regclass('public.' || expected.table_name)
  LEFT JOIN pg_stat_activity activity ON activity.pid=progress.pid
  WHERE progress.datid=(SELECT oid FROM pg_database WHERE datname=current_database()) LIMIT 17
), ${historicalCompatibilityCtes}
SELECT json_build_object(
 'indexes', (SELECT json_agg(inspected) FROM inspected),
 'receipts', COALESCE((SELECT json_agg(receipts) FROM receipts), '[]'::json),
 'artifacts', COALESCE((SELECT json_agg(relname) FROM artifacts), '[]'::json),
 'builders', COALESCE((SELECT json_agg(builders) FROM builders), '[]'::json),
 'historicalCompatibility', ${historicalCompatibilityProjection}
);
COMMIT;`;

export function verifyOutcomeCohortPreparationState(snapshot, source) {
  if (
    !snapshot ||
    !Array.isArray(snapshot.receipts) ||
    !Array.isArray(snapshot.indexes) ||
    !Array.isArray(snapshot.artifacts) ||
    snapshot.artifacts.length ||
    !Array.isArray(snapshot.builders) ||
    snapshot.builders.length ||
    snapshot.receipts.length > OUTCOME_COHORT_RECEIPT_LIMIT ||
    snapshot.indexes.length !== 2
  )
    fail('STATE_INVALID');
  // FLAG: Validate every active receipt before considering the four exact historical
  // variants. Their pinned successor receipts and current catalog must agree; no
  // receipt is rewritten and an unknown or unfinished migration still blocks release.
  const active = validateOnlineMigrationReceipts(snapshot, source, () => fail('RECEIPT_BLOCKED'));
  const targets = OUTCOME_COHORT_TARGETS.map((target) => {
    const indexes = snapshot.indexes.filter((index) => index.selector === target.selector);
    if (
      indexes.length !== 1 ||
      typeof indexes[0].present !== 'boolean' ||
      typeof indexes[0].exact !== 'boolean'
    )
      fail('STATE_INVALID');
    const applied = active.has(target.migration);
    if ((applied && !indexes[0].exact) || (!applied && indexes[0].present)) fail('INDEX_BLOCKED');
    return { selector: target.selector, applied };
  });
  for (const migration of source) {
    if (migration.name >= OUTCOME_COHORT_TARGETS[0].migration) break;
    if (!active.has(migration.name)) fail('PREREQUISITE_MISSING');
  }
  // A future source migration inserted between the fixed targets may not run in this adapter.
  for (const migration of source)
    if (
      migration.name < OUTCOME_COHORT_TARGETS[1].migration &&
      !OUTCOME_COHORT_TARGETS.some((target) => target.migration === migration.name) &&
      !active.has(migration.name)
    )
      fail('PREREQUISITE_MISSING');
  if (targets[1].applied && !targets[0].applied) fail('RECEIPT_BLOCKED');
  const pending = targets.filter((target) => !target.applied).map((target) => target.selector);
  return { state: pending.length ? `prepare_${pending[0]}` : 'already_applied', pending };
}

export async function runOutcomeCohortCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 2 * 1024 * 1024,
        killSignal: 'SIGKILL',
        ...options,
      },
      (error, stdout) => (error ? reject(error) : resolve({ stdout })),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
  });
}

export function projectOutcomeCohortPreview(snapshot, source) {
  if (
    !snapshot ||
    !Array.isArray(snapshot.receipts) ||
    snapshot.receipts.length > OUTCOME_COHORT_RECEIPT_LIMIT ||
    !Array.isArray(snapshot.indexes) ||
    snapshot.indexes.length !== 2 ||
    !Array.isArray(snapshot.artifacts) ||
    snapshot.artifacts.length > 16 ||
    !Array.isArray(snapshot.builders) ||
    snapshot.builders.length > 16
  )
    fail('PREVIEW_CAPPED_OR_INVALID');
  let state;
  try {
    state = verifyOutcomeCohortPreparationState(snapshot, source).state;
  } catch (error) {
    state = error.message;
  }
  return {
    stage: 'outcome_cohort_preview',
    state,
    targets: OUTCOME_COHORT_TARGETS.map((target) => ({
      selector: target.selector,
      migration: target.migration,
      expectedChecksum: target.checksum,
      index: snapshot.indexes.find((index) => index.selector === target.selector),
      receipts: snapshot.receipts
        .filter((receipt) => receipt.name === target.migration)
        .map((receipt) => ({
          id: receipt.id,
          checksum: receipt.checksum,
          startedAt: receipt.started_at,
          finished: receipt.finished,
          rolledBack: receipt.rolled_back,
          steps: receipt.steps,
          failureFamily: receipt.failure_family,
        })),
    })),
    artifacts: snapshot.artifacts,
    builders: snapshot.builders,
  };
}

async function collectOutcomeCohortState(
  composeArgs,
  { root = process.cwd(), run = runOutcomeCohortCommand } = {},
) {
  const { validateMultibotComposeArgs } = await import('./multibot-prepare-capacity.mjs');
  validateMultibotComposeArgs(composeArgs);
  const source = readOutcomeCohortSource(root);
  try {
    const result = await run(
      'docker',
      [
        'compose',
        ...composeArgs,
        'exec',
        '-T',
        'postgres',
        'psql',
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'maxim',
        '-d',
        'maxim',
        '-Atq',
      ],
      { input: outcomeCohortStateSql },
    );
    return { snapshot: JSON.parse(result.stdout.trim()), source };
  } catch (error) {
    if (/^OUTCOME_COHORT_[A-Z_]+$/u.test(error?.message ?? '')) throw error;
    fail('STATE_UNAVAILABLE');
  }
}

export async function readOutcomeCohortState(composeArgs, options) {
  const { snapshot, source } = await collectOutcomeCohortState(composeArgs, options);
  return verifyOutcomeCohortPreparationState(snapshot, source);
}

export async function readOutcomeCohortPreview(composeArgs, options) {
  const { snapshot, source } = await collectOutcomeCohortState(composeArgs, options);
  return projectOutcomeCohortPreview(snapshot, source);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const [mode, ...composeArgs] = process.argv.slice(2);
    if (mode === 'preview')
      console.log(JSON.stringify(await readOutcomeCohortPreview(composeArgs)));
    else if (mode === 'assert') {
      const state = await readOutcomeCohortState(composeArgs);
      if (state.state !== 'already_applied') fail('PREPARATION_INCOMPLETE');
      console.log(JSON.stringify({ stage: 'outcome_cohort_assert', state: state.state }));
    } else fail('ARGUMENTS_INVALID');
  } catch {
    console.error('OUTCOME_COHORT_ASSERT_FAILED');
    process.exitCode = 1;
  }
}
