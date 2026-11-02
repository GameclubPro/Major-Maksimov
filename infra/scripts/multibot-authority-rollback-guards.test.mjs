import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const library = resolve(root, 'infra/scripts/lib/deploy-topology.sh');
const nativePostgresUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim();
const paths = [
  'apps/api/src/webhook/webhook-semantic-authority.ts',
  'apps/api/src/webhook/webhook.service.ts',
  'apps/api/src/moderation/webhook-canonical-execution.service.ts',
  'apps/api/src/common/group-command-authority.service.ts',
  'apps/api/src/max/max-mutation-outcome.util.ts',
  'apps/api/src/max/max-client.service.ts',
  'apps/api/prisma/schema.prisma',
  'apps/api/src/common/group-command-notice-recovery.ts',
  'apps/api/src/common/group-command-notice-delivery.ts',
  'apps/api/src/moderation/moderation.service.legacy.ts',
  'apps/api/src/webhook/webhook-outbox.service.ts',
  'apps/api/src/webhook/webhook-legacy-authority.ts',
  'apps/api/src/webhook/webhook-dependency-quarantine.service.ts',
];

test('both rollback paths reject targets that erase shared multibot authority', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'maxim-multibot-rollback-'));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: fixture,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const commit = () => {
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'authority fixture',
    );
    return git('rev-parse', 'HEAD');
  };
  const check = (sha) =>
    spawnSync(
      'bash',
      [
        '-c',
        'source "$1"; maxim_topology_require_multibot_authority "$2" && maxim_topology_require_dependency_quarantine "$2"',
        'multibot-test',
        library,
        sha,
      ],
      { cwd: fixture, encoding: 'utf8' },
    );
  try {
    git('init', '-q', '-b', 'main');
    for (const path of paths) {
      mkdirSync(dirname(resolve(fixture, path)), { recursive: true });
      writeFileSync(resolve(fixture, path), readFileSync(resolve(root, path)));
    }
    const positive = check(commit());
    assert.equal(
      positive.status,
      0,
      `Current authority fixture was rejected: signal=${positive.signal ?? 'none'} error=${positive.error?.message ?? 'none'}\nstdout:\n${positive.stdout}\nstderr:\n${positive.stderr}`,
    );
    const legacyPath = paths[11];
    const legacySource = readFileSync(resolve(fixture, legacyPath), 'utf8');
    writeFileSync(
      resolve(fixture, legacyPath),
      legacySource
        .replace('value <= ownerMs + LEGACY_SOURCE_CLOCK_LEAD_MS;', 'value <= ownerMs;')
        .replace(
          'hasNewOriginalSource(currentOwner, cutoff) &&\n        currentOwner.errorMessage !== LEGACY_EXECUTION_UNVERIFIED_MARKER',
          'hasNewOriginalSource(currentOwner, cutoff)',
        ),
    );
    assert.equal(
      check(commit()).status,
      0,
      'Strict historical source clock bound must remain compatible',
    );
    writeFileSync(resolve(fixture, legacyPath), legacySource);
    const commandPath = paths[3];
    const commandSource = readFileSync(resolve(fixture, commandPath), 'utf8');
    writeFileSync(
      resolve(fixture, commandPath),
      commandSource.replaceAll('advanceChatMutationOrder', 'unsafeLegacyMutationOrder'),
    );
    assert.equal(check(commit()).status, 1);
    writeFileSync(resolve(fixture, commandPath), commandSource);
    const schemaPath = paths[6];
    const schemaSource = readFileSync(resolve(root, schemaPath), 'utf8');
    const cascadeSchema = schemaSource.replace(
      /model WebhookExecutionClaim \{[\s\S]*?\n\}/u,
      (model) => model.replace('onDelete: SetNull', 'onDelete: Cascade'),
    );
    // Other SetNull relations must not certify this exact execution tombstone relation.
    assert.match(cascadeSchema, /onDelete: SetNull/u);
    writeFileSync(resolve(fixture, schemaPath), cascadeSchema);
    assert.equal(check(commit()).status, 1);
    writeFileSync(
      resolve(fixture, schemaPath),
      schemaSource.replace(/(webhookEventId\s+String)\?/u, '$1'),
    );
    assert.equal(check(commit()).status, 1);
    writeFileSync(resolve(fixture, schemaPath), schemaSource);
    const clientPath = paths[5];
    writeFileSync(
      resolve(fixture, clientPath),
      readFileSync(resolve(root, clientPath), 'utf8').replaceAll(
        'verifyChatExecutionProof(',
        'unsafeUncheckedRoute(',
      ),
    );
    assert.equal(check(commit()).status, 1);
    writeFileSync(resolve(fixture, clientPath), readFileSync(resolve(root, clientPath)));
    for (const [path, capability, replacement] of [
      [paths[2], 'latestWebhookEvent.status === WebhookStatus.QUARANTINED', 'false'],
      [paths[1], 'event.status === WebhookStatus.QUARANTINED', 'false'],
      [paths[10], 'quarantine."blocker_id" = candidate."id"', 'false'],
      [paths[2], 'tryRecoverFinishedExecution(', 'unsafeLegacyFinishedRecovery('],
      [paths[2], 'holdUnverifiedLegacyExecution(', 'unsafeLegacyAuthorityPromotion('],
      [paths[2], 'transitionLiveUnstartedOwnerWithClient(', 'unsafeExpiredLeaseTransition('],
      [paths[1], 'transitionLiveUnstartedOwnerWithClient(', 'unsafeExpiredPreparation('],
      [paths[1], 'claim.webhookEventId === null', 'claim.webhookEventId === undefined'],
      [paths[7], 'COMMAND_NOTICE_PENDING', 'UNREADABLE_PENDING_NOTICE'],
      [paths[7], 'COMMAND_NOTICE_EXPIRED', 'UNREADABLE_EXPIRED_NOTICE'],
      [paths[8], 'permit.executionDeadlineAt', 'permit.unsafeNoticeDeadlineAt'],
      [paths[9], 'recoverGroupCommandNotice(', 'unsafeWholeEngineRetry('],
      [paths[10], 'webhookRetentionProofUnpinnedSql()', 'unsafeUnpinnedRetentionSql()'],
      [paths[11], 'LEGACY_EXECUTION_UNVERIFIED', 'unsafeLegacyPromotion'],
      [paths[11], 'claim.createdAt.getTime() > cutoff.getTime()', 'claim.enforced'],
      [paths[11], 'currentOwner.createdAt.getTime() > cutoff.getTime()', 'true'],
      [paths[11], 'hasNewOriginalSource(currentOwner, cutoff)', 'true'],
      [paths[11], "if (sourceMarker === 'ingress') return false;", ''],
      [paths[11], "if (!raw && sourceMarker !== 'payload') return false;", ''],
      [paths[11], 'const source = raw ?? payload;', 'const source = payload;'],
      [paths[11], 'value > cutoffMs && value <= ownerMs', 'value > 0'],
      [
        paths[11],
        'const LEGACY_SOURCE_CLOCK_LEAD_MS = 1_000;',
        'const LEGACY_SOURCE_CLOCK_LEAD_MS = 60_000;',
      ],
      [paths[11], 'currentOwner.errorMessage !== LEGACY_EXECUTION_UNVERIFIED_MARKER', 'true'],
      [paths[11], "message: !raw || type === 'message_created' ? message : undefined,", 'message,'],
      [paths[11], '!isNewSource(parseWebhookEventTimestampMs(message[field]))', 'false'],
      [
        paths[11],
        'where: { semanticKey: claim.semanticKey, createdAt: { lte: cutoff } },',
        'where: { semanticKey: claim.semanticKey },',
      ],
      [paths[11], 'if (!oldMirror) return false;', 'return false;'],
    ]) {
      const original = readFileSync(resolve(root, path), 'utf8');
      assert.ok(original.includes(capability), `Fixture missing ${capability}`);
      writeFileSync(resolve(fixture, path), original.replaceAll(capability, replacement));
      assert.equal(check(commit()).status, 1, `Rollback accepted missing ${capability}`);
      writeFileSync(resolve(fixture, path), original);
    }
    rmSync(resolve(fixture, paths[7]));
    assert.equal(check(commit()).status, 1, 'Rollback accepted missing saved notice decoder');
    for (const path of [
      'infra/scripts/vps-release-rollback.sh',
      'infra/scripts/vps-runtime-rollback.sh',
    ]) {
      assert.match(
        readFileSync(resolve(root, path), 'utf8'),
        /maxim_topology_require_multibot_authority/u,
      );
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('first authority cutover stops legacy ingress before the migration effects cutoff', () => {
  const deploy = readFileSync(resolve(root, 'infra/scripts/vps-pull-build-up.sh'), 'utf8');
  const onlinePrepare = deploy.indexOf(
    '\n  maxim_webhook_prepare_multibot_before_quiescence COMPOSE_FILES',
  );
  const quiesce = deploy.indexOf('\n  maxim_webhook_quiesce_for_api_rollout COMPOSE_FILES');
  const ingress = deploy.indexOf(
    '\n  maxim_webhook_quiesce_legacy_ingress_for_multibot_cutover COMPOSE_FILES',
  );
  const migration = deploy.indexOf('\n  if ! run_migrations');
  const migrationEnd = deploy.indexOf('\n  fi', migration);
  const postcheck = deploy.indexOf(
    '\n  maxim_webhook_assert_multibot_migration_indexes COMPOSE_FILES',
  );
  const recreate = deploy.indexOf('\n  recreate_service_wave ', migration);
  assert.ok(
    onlinePrepare >= 0 &&
      quiesce > onlinePrepare &&
      ingress > quiesce &&
      migration > ingress &&
      migrationEnd > migration &&
      postcheck > migrationEnd &&
      recreate > postcheck,
  );
});

test('cutover receipt and stopped ingress checks fail closed; later releases keep ingress live', () => {
  const cutoverLibrary = resolve(root, 'infra/scripts/lib/webhook-rollout-quiescence.sh');
  const probe = (receipt, running = '') =>
    spawnSync(
      'bash',
      [
        '-c',
        `
    set -euo pipefail
    ROOT_DIR="$1"
    source "$2"
    receipt="$3"
    running="$4"
    COMPOSE_FILES=(-f fixture.yml)
    timeout() { shift 3; "$@"; }
    maxim_webhook_assert_api_rollout_quiescence() { echo quiescent; }
    docker() {
      case "$*" in
        *"exec -T postgres"*) cat >/dev/null; printf '%s\\n' "$receipt" ;;
        *"stop"*) echo stopped >&2 ;;
        *"ps --status running"*) printf '%s' "$running" ;;
        *) return 1 ;;
      esac
    }
    maxim_webhook_quiesce_legacy_ingress_for_multibot_cutover COMPOSE_FILES
    printf 'held=%s\\n' "$MAXIM_MULTIBOT_LEGACY_INGRESS_STOPPED"
  `,
        'multibot-cutover',
        root,
        cutoverLibrary,
        receipt,
        running,
      ],
      { encoding: 'utf8' },
    );
  const initial = probe('0');
  assert.equal(initial.status, 0, initial.stderr);
  assert.match(initial.stderr, /stopped/u);
  assert.match(initial.stdout, /held=1/u);
  const compatible = probe('1');
  assert.equal(compatible.status, 0, compatible.stderr);
  assert.doesNotMatch(compatible.stderr, /stopped/u);
  assert.match(compatible.stdout, /held=0/u);
  assert.notEqual(probe('unknown').status, 0);
  assert.notEqual(probe('0', 'still-running').status, 0);
});

test('migration index readiness postcheck rejects partial, malformed, database and timeout results while fenced', () => {
  const quiescenceLibrary = resolve(root, 'infra/scripts/lib/webhook-rollout-quiescence.sh');
  const probe = (result, databaseStatus = '0', timeoutStatus = '0') =>
    spawnSync(
      'bash',
      [
        '-c',
        `
      set -euo pipefail
      ROOT_DIR="$1"
      source "$2"
      catalog_result="$3"
      database_status="$4"
      timeout_status="$5"
      COMPOSE_FILES=(-f fixture.yml)
      MAXIM_WEBHOOK_QUEUES_MAY_BE_PAUSED=1
      MAXIM_MULTIBOT_LEGACY_INGRESS_STOPPED=1
      recreated=0
      trap 'printf "paused=%s ingress-stopped=%s recreated=%s\\n" "$MAXIM_WEBHOOK_QUEUES_MAY_BE_PAUSED" "$MAXIM_MULTIBOT_LEGACY_INGRESS_STOPPED" "$recreated"' EXIT
      timeout() {
        [[ "$1" == --foreground && "$2" == --kill-after=5s && "$3" == 30s ]] || return 99
        if [[ "$timeout_status" != 0 ]]; then return "$timeout_status"; fi
        shift 3
        "$@"
      }
      docker() {
        [[ "$*" == *"exec -T postgres psql -X -v ON_ERROR_STOP=1 -U maxim -d maxim -Atq"* ]] || return 98
        sql="$(cat)"
        [[ "$sql" == *"BEGIN READ ONLY;"* && "$sql" == *"statement_timeout = '10s'"* ]] || return 97
        [[ "$sql" == *"pg_catalog.pg_class"* && "$sql" == *"pg_catalog.pg_index"* ]] || return 96
        [[ "$sql" == *"index_relation.relnamespace = 'public'::regnamespace"* ]] || return 95
        [[ "$sql" == *"index_state.indrelid = 'public.webhook_events'::regclass"* ]] || return 94
        [[ "$sql" == *"index_state.indisvalid AND index_state.indisready AND index_state.indislive"* ]] || return 93
        [[ "$sql" == *"webhook_events_semantic_order_idx"* && "$sql" == *"webhook_events_status_created_at_id_idx"* && "$sql" == *"webhook_events_semantic_replay_fence_idx"* ]] || return 92
        printf '%s\\n' "$catalog_result"
        return "$database_status"
      }
      maxim_webhook_assert_multibot_migration_indexes COMPOSE_FILES
      recreated=1
    `,
        'multibot-index-postcheck',
        root,
        quiescenceLibrary,
        result,
        databaseStatus,
        timeoutStatus,
      ],
      { encoding: 'utf8' },
    );
  const ready = probe('3');
  assert.equal(ready.status, 0, ready.stderr);
  assert.match(ready.stdout, /paused=1 ingress-stopped=1 recreated=1/u);
  for (const result of ['0', '1', '2', '4', '', '3\n3', 'true', '03', ' 3']) {
    const rejected = probe(result);
    assert.notEqual(
      rejected.status,
      0,
      `Accepted malformed/unready catalog result ${JSON.stringify(result)}`,
    );
    assert.match(rejected.stdout, /paused=1 ingress-stopped=1 recreated=0/u);
    assert.match(rejected.stderr, /release fence remains held/u);
  }
  for (const rejected of [probe('3', '1'), probe('3', '0', '124')]) {
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stdout, /paused=1 ingress-stopped=1 recreated=0/u);
    assert.match(rejected.stderr, /Could not inspect.*release fence remains held/u);
  }
});

test('multibot migrations bound locks and preserve atomic DDL without hiding partial concurrent builds', () => {
  for (const [name, lockSeconds] of [
    ['20261005015900_prepare_multibot_webhook_columns', 5],
    ['20261005020000_add_multibot_order_fences', 5],
    ['20261005020200_preserve_semantic_execution_tombstones', 3],
  ]) {
    const migration = readFileSync(
      resolve(root, 'apps/api/prisma/migrations', name, 'migration.sql'),
      'utf8',
    );
    const begin = migration.indexOf('BEGIN;');
    const lock = migration.indexOf(`SET LOCAL lock_timeout = '${lockSeconds}s';`);
    const statement = migration.indexOf("SET LOCAL statement_timeout = '30s';");
    const alter = migration.indexOf('ALTER TABLE');
    const commit = migration.indexOf('COMMIT;');
    assert.ok(
      begin >= 0 && lock > begin && statement > lock && alter > statement && commit > alter,
      name,
    );
    assert.doesNotMatch(migration, /CREATE INDEX CONCURRENTLY/u);
  }
  for (const [name, indexes] of [
    ['20261005016000_add_multibot_semantic_order_index', 1],
    ['20261005016100_index_multibot_retention_cursor', 2],
  ]) {
    const migration = readFileSync(
      resolve(root, 'apps/api/prisma/migrations', name, 'migration.sql'),
      'utf8',
    );
    const lock = migration.indexOf("SET lock_timeout = '5s';");
    const statement = migration.indexOf("SET statement_timeout = '1800s';");
    const create = migration.indexOf('CREATE INDEX CONCURRENTLY');
    assert.ok(lock >= 0 && statement > lock && create > statement, name);
    assert.equal(migration.match(/CREATE INDEX CONCURRENTLY/gu)?.length, indexes, name);
    assert.doesNotMatch(migration, /CREATE INDEX CONCURRENTLY\s+IF NOT EXISTS/u);
    assert.doesNotMatch(migration, /^\s*BEGIN\b/mu);
    assert.ok(migration.lastIndexOf('RESET statement_timeout;') > create, name);
    assert.ok(migration.lastIndexOf('RESET lock_timeout;') > create, name);
  }
});

test(
  'native catalog postcheck rejects an interrupted concurrent index and accepts its repaired index',
  { skip: !nativePostgresUrl, timeout: 30_000 },
  async () => {
    const address = new URL(nativePostgresUrl);
    assert.ok(
      ['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) &&
        address.pathname.includes('race_test'),
      'Native index fixture requires the disposable local PostgreSQL race_test database',
    );
    const { default: pg } = await import('pg');
    const client = new pg.Client({
      connectionString: nativePostgresUrl,
      connectionTimeoutMillis: 5_000,
      query_timeout: 10_000,
      options: '-c statement_timeout=10000 -c lock_timeout=3000 -c timezone=UTC',
    });
    const schemaName = `multibot_indexes_${randomUUID().replaceAll('-', '')}`;
    const schema = `"${schemaName}"`;
    const table = `${schema}."webhook_events"`;
    const indexNames = [
      'webhook_events_semantic_order_idx',
      'webhook_events_status_created_at_id_idx',
      'webhook_events_semantic_replay_fence_idx',
    ];
    const source = readFileSync(
      resolve(root, 'infra/scripts/lib/webhook-rollout-quiescence.sh'),
      'utf8',
    );
    const helperStart = source.indexOf('maxim_webhook_assert_multibot_migration_indexes()');
    const sqlStart = source.indexOf("<<'SQL'\n", helperStart);
    const sqlEnd = source.indexOf('\nSQL\n', sqlStart);
    assert.ok(helperStart >= 0 && sqlStart > helperStart && sqlEnd > sqlStart);
    // FLAG: Run the deployed metadata query verbatim except its namespace. The unique
    // fixture schema keeps failed concurrent builds isolated from every application table.
    const sql = source
      .slice(sqlStart + "<<'SQL'\n".length, sqlEnd)
      .replace("'public'::regnamespace", `'${schemaName}'::regnamespace`)
      .replace("'public.webhook_events'::regclass", `'${schemaName}.webhook_events'::regclass`);
    const readyCount = async () => {
      const statements = await client.query(sql);
      const count = statements.flatMap((statement) => statement.rows).find((row) => row.count);
      assert.ok(count, 'Deployed catalog query must return its index readiness count');
      return count.count;
    };
    let connected = false;
    try {
      await client.connect();
      connected = true;
      const identity = await client.query(
        "SELECT version() AS version, current_setting('TimeZone') AS timezone",
      );
      assert.match(identity.rows[0].version, /^PostgreSQL /u);
      assert.doesNotMatch(identity.rows[0].version, /pglite|wasm/iu);
      assert.equal(identity.rows[0].timezone, 'UTC');
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`CREATE TABLE ${table} (
        id text, semantic_key text, created_at timestamp,
        status public."WebhookStatus", next_enqueue_at timestamp,
        timeout_quarantine_expires_at timestamp, error_message text
      )`);
      await client.query(
        `INSERT INTO ${table} (id, semantic_key) VALUES ('1', 'same'), ('2', 'same')`,
      );
      assert.equal(await readyCount(), '0');
      for (const name of indexNames) await client.query(`CREATE INDEX "${name}" ON ${table} (id)`);
      assert.equal(await readyCount(), '0', 'Correct names with the wrong definition are rejected');
      for (const name of indexNames) await client.query(`DROP INDEX ${schema}."${name}"`);
      const createIndex = async (name, transform = (statement) => statement) => {
        const migration = readFileSync(
          resolve(
            root,
            'apps/api/prisma/migrations',
            name === indexNames[0]
              ? '20261005016000_add_multibot_semantic_order_index'
              : '20261005016100_index_multibot_retention_cursor',
            'migration.sql',
          ),
          'utf8',
        );
        const statement = migration.match(
          new RegExp(`CREATE INDEX CONCURRENTLY "${name}"[\\s\\S]+?;`, 'u'),
        )?.[0];
        assert.ok(statement);
        await client.query(transform(statement.replace('"webhook_events"', table)));
      };
      for (const name of indexNames) await createIndex(name);
      assert.equal(await readyCount(), '3');
      await client.query(`DROP INDEX ${schema}."${indexNames[0]}"`);
      await createIndex(indexNames[0], (statement) =>
        statement.replace('WHERE "semantic_key" IS NOT NULL', 'WHERE true'),
      );
      assert.equal(await readyCount(), '2', 'A valid index with the wrong predicate is rejected');
      await client.query(`DROP INDEX ${schema}."${indexNames[0]}"`);
      await createIndex(indexNames[0], (statement) =>
        statement.replace('"created_at", "id")', '"created_at" DESC, "id")'),
      );
      assert.equal(await readyCount(), '2', 'A valid descending key order is rejected');
      await client.query(`DROP INDEX ${schema}."${indexNames[0]}"`);
      await createIndex(indexNames[0]);
      assert.equal(await readyCount(), '3');
      await client.query(`DROP INDEX ${schema}."${indexNames[0]}"`);
      await assert.rejects(
        client.query(
          `CREATE UNIQUE INDEX CONCURRENTLY "${indexNames[0]}" ON ${table} (semantic_key)`,
        ),
        (error) => error.code === '23505',
      );
      const interrupted = await client.query(
        `SELECT index_state.indisvalid FROM pg_catalog.pg_class index_relation
         JOIN pg_catalog.pg_index index_state ON index_state.indexrelid = index_relation.oid
         WHERE index_relation.relnamespace = $1::regnamespace AND index_relation.relname = $2`,
        [schemaName, indexNames[0]],
      );
      assert.deepEqual(interrupted.rows, [{ indisvalid: false }]);
      assert.equal(await readyCount(), '2');
      await client.query(`DROP INDEX CONCURRENTLY ${schema}."${indexNames[0]}"`);
      await createIndex(indexNames[0]);
      assert.equal(await readyCount(), '3');
    } finally {
      try {
        if (connected) {
          await client.query('ROLLBACK');
          await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        }
      } finally {
        await client.end();
      }
    }
  },
);
