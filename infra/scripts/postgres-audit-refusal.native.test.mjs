import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  COMMERCIAL_QUALITY_AUDIT_COLUMNS,
  buildCommercialQualityIndexReadinessSql,
  buildCommercialQualityPrivilegesSql,
} from './commercial-quality-audit.mjs';
import { buildLegacyDefaultWebhookDbAuditSql } from './legacy-default-webhook-db-audit.mjs';
import { buildPublisherAccessCensusReadinessSql } from './publisher-access-census.mjs';
import {
  PUBLISHER_PUBLICATION_AUDIT_COLUMNS,
  buildPublisherPublicationIndexReadinessSql,
  buildPublisherPublicationPrivilegesSql,
} from './publisher-publications-audit.mjs';
import {
  PUBLISHER_SLOT_AUDIT_COLUMNS,
  buildPublisherSlotIndexSql,
  buildPublisherSlotPrivilegesSql,
} from './publisher-slot-audit.mjs';

const require = createRequire(import.meta.url);
const {
  inspectLegacyDefaultWebhookQueue,
  QUEUE_STATES,
} = require('./legacy-default-webhook-queue-retirement.cjs');
const nativeUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim() ?? '';
const statuses = ['SCHEDULED', 'IN_PROGRESS', 'SENT', 'PARTIAL', 'FAILED', 'AMBIGUOUS', 'CANCELED'];
const publisherFixture = readFileSync(
  new URL('./test-fixtures/publisher-publications.sql', import.meta.url),
  'utf8',
)
  .replace(
    /CREATE TYPE "PublicationOccurrenceStatus"[^;]+;/u,
    `CREATE TYPE "PublicationOccurrenceStatus" AS ENUM (${statuses.map((value) => `'${value}'`).join(',')});`,
  )
  .replaceAll('TIMESTAMPTZ', 'TIMESTAMP(3)');
const fixture = `${publisherFixture}
CREATE TABLE managed_broadcasts (id text PRIMARY KEY);
${Object.entries(PUBLISHER_SLOT_AUDIT_COLUMNS)
  .flatMap(([table, columns]) =>
    columns.map(
      (column) =>
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${
          column === 'dispatch_profile'
            ? '"PublicationDispatchProfile"'
            : column.endsWith('_at')
              ? 'timestamp(3)'
              : 'text'
        };`,
    ),
  )
  .join('\n')}
CREATE UNIQUE INDEX publication_targets_publication_target_key
  ON publication_targets(publication_id, target_chat_id);
CREATE TABLE commercial_review_samples (
  id text PRIMARY KEY, observed_at timestamp(3), expires_at timestamp(3), source text,
  independent_label text, independent_review_count integer, review_state text, quality_metadata jsonb
);
CREATE INDEX commercial_review_samples_blind_queue_idx
  ON commercial_review_samples(observed_at DESC, id DESC);
CREATE TABLE webhook_events (
  id text PRIMARY KEY, status text, error_message text, next_enqueue_at timestamp(3)
);`;
const grants = (columns) =>
  Object.entries(columns)
    .map(([table, fields]) => `GRANT SELECT (${fields.join(',')}) ON ${table} TO maxim_audit;`)
    .join('\n');

test(
  'native psql preserves admitted audits and refuses every metadata/index guard before report execution',
  { skip: !nativeUrl, timeout: 30_000 },
  async (t) => {
    const address = new URL(nativeUrl);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(address.hostname));
    assert.match(address.pathname, /^\/(?:race_test|maxim_race_test_[a-f0-9]+)$/u);
    const directory = mkdtempSync(join(tmpdir(), 'maxim-audit-refusal-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const snapshot = await inspectLegacyDefaultWebhookQueue({
      name: 'moderation-default',
      waitUntilReady: async () => {},
      getVersion: async () => null,
      isPaused: async () => false,
      getWorkersCount: async () => 0,
      getJobSchedulersCount: async () => 0,
      getJobCounts: async () => Object.fromEntries(QUEUE_STATES.map((state) => [state, 0])),
      getJobs: async () => [],
      pause: async () => {},
      obliterate: async () => {},
      close: async () => {},
    });
    const snapshotPath = join(directory, 'snapshot.json');
    writeFileSync(snapshotPath, JSON.stringify(snapshot), { mode: 0o600 });
    const censusGrants = grants({
      publisher_entity_bindings: [
        'chat_id',
        'publisher_bot_id',
        'status',
        'bot_access_state',
        'bot_access_checked_at',
        'bot_access_expires_at',
        'bot_access_source',
      ],
    });
    const cases = [
      [
        'commercial privileges',
        buildCommercialQualityPrivilegesSql(true),
        grants({ commercial_review_samples: COMMERCIAL_QUALITY_AUDIT_COLUMNS }),
        'REVOKE SELECT (source) ON commercial_review_samples FROM maxim_audit;',
      ],
      [
        'commercial index',
        buildCommercialQualityIndexReadinessSql(),
        '',
        'DROP INDEX commercial_review_samples_blind_queue_idx;',
      ],
      [
        'publication privileges',
        buildPublisherPublicationPrivilegesSql(true),
        grants(PUBLISHER_PUBLICATION_AUDIT_COLUMNS),
        'REVOKE SELECT (actor_user_id) ON publications FROM maxim_audit;',
      ],
      [
        'publication indexes',
        buildPublisherPublicationIndexReadinessSql(),
        '',
        'DROP INDEX publication_occurrences_dispatch_status_scheduled_idx;',
      ],
      [
        'slot privileges',
        buildPublisherSlotPrivilegesSql(true),
        grants(PUBLISHER_SLOT_AUDIT_COLUMNS),
        'REVOKE SELECT (next_send_at) ON managed_broadcasts FROM maxim_audit;',
      ],
      [
        'slot indexes',
        buildPublisherSlotIndexSql(),
        '',
        'DROP INDEX publication_targets_publication_target_key;',
      ],
      [
        'legacy webhook primary key',
        buildLegacyDefaultWebhookDbAuditSql(snapshotPath),
        '',
        'ALTER TABLE webhook_events DROP CONSTRAINT webhook_events_pkey;',
      ],
      [
        'access census metadata',
        buildPublisherAccessCensusReadinessSql(),
        censusGrants,
        'REVOKE SELECT (bot_access_source) ON publisher_entity_bindings FROM maxim_audit;',
      ],
    ];
    for (const [name, sql, setup, failure] of cases) {
      await t.test(name, () => {
        for (const refused of [false, true]) {
          // FLAG: Each real psql invocation owns a rolled-back schema and role. Only
          // fixture namespace/role references change; the emitted guard remains intact.
          const suffix = randomUUID().replaceAll('-', '');
          const schema = `audit_guard_${suffix}`;
          const role = `audit_reader_${suffix}`;
          const source = `BEGIN;
CREATE SCHEMA ${schema};
CREATE ROLE ${role};
SET LOCAL search_path TO ${schema}, public;
${fixture}
${setup}
${refused ? failure : ''}
${sql}
SELECT 'audit-report-after-guard';
ROLLBACK;`
            .replaceAll('public.', `${schema}.`)
            .replaceAll("'public'", `'${schema}'`)
            .replaceAll('maxim_audit', role);
          const result = spawnSync(
            'psql',
            ['-X', '--no-password', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=terse'],
            {
              encoding: 'utf8',
              timeout: 5000,
              input: source,
              env: {
                ...process.env,
                PGHOST: address.hostname,
                PGPORT: address.port,
                PGUSER: decodeURIComponent(address.username),
                PGPASSWORD: decodeURIComponent(address.password),
                PGDATABASE: decodeURIComponent(address.pathname.slice(1)),
                PGOPTIONS: '-c statement_timeout=3000 -c lock_timeout=500',
              },
            },
          );
          assert.equal(result.status, refused ? 3 : 0, result.stderr);
          assert.equal(result.stdout.includes('audit-report-after-guard'), !refused, result.stdout);
          if (refused) assert.match(result.stderr, /division by zero/u);
        }
      });
    }
  },
);
