import {
  PUBLISHER_DEFERRAL_MIGRATIONS,
  SPAMMER_DEFERRAL_MIGRATIONS,
} from './routing-index-catalog.mjs';
import { ROUTING_INDEX_TARGET } from './routing-index-online-target.mjs';

const migrationsPrefix = 'apps/api/prisma/migrations/';
const pinnedMigrations = new Set([
  ROUTING_INDEX_TARGET.migration,
  ...[...PUBLISHER_DEFERRAL_MIGRATIONS, ...SPAMMER_DEFERRAL_MIGRATIONS].map(({ name }) => name),
]);
const routingPolicyPaths = new Set([
  'apps/api/src/webhook/webhook-routing.service.ts',
  'scripts/agent/online-migration-receipts.mjs',
  'scripts/agent/routing-index-catalog.mjs',
  'scripts/agent/routing-index-online-prepare.mjs',
  'scripts/agent/routing-index-online-target.mjs',
  'infra/scripts/lib/routing-index-online-prepare.sh',
  'infra/scripts/routing-index-online-state.mjs',
  'infra/scripts/routing-index-online-supervisor.mjs',
  'infra/scripts/routing-index-prepare-capacity.mjs',
]);

export function buildMigrationReadiness(changedPaths) {
  const paths = [...changedPaths];
  const migrationFiles = paths.filter((path) => path.startsWith(migrationsPrefix));
  const schemaChanged = paths.includes('apps/api/prisma/schema.prisma');
  const routingPolicyChanged = paths.some((path) => routingPolicyPaths.has(path));
  if (!migrationFiles.length && !schemaChanged && !routingPolicyChanged) return null;

  // FLAG: Changed Git paths only flag a risk. The locked deploy verifies exact source
  // checksums, index definitions and receipts before deciding which route is permitted.
  const migrationNames = migrationFiles
    .map((path) => path.slice(migrationsPrefix.length))
    .map((path) => /^(\d{14}_[a-z0-9_]+)\/migration\.sql$/u.exec(path)?.[1])
    .filter(Boolean);
  return {
    migrationFilesChanged: migrationFiles.length > 0,
    schemaChanged,
    routingPolicyChanged,
    unpinnedTailChanged: migrationNames.some(
      (name) => name > ROUTING_INDEX_TARGET.migration && !pinnedMigrations.has(name),
    ),
    pinnedSourceChanged: migrationNames.some((name) => pinnedMigrations.has(name)),
    routingTableScopeGiB: ROUTING_INDEX_TARGET.tableCeilingBytes / 1024 ** 3,
  };
}

export function renderMigrationReadiness(report) {
  if (!report) return '';
  const lines = ['Migration readiness (local Git paths only).'];
  if (report.unpinnedTailChanged) {
    lines.push(
      '  A changed migration after the routing index is outside the pinned lists. If the index is still pending, a new tail can require normal index preparation.',
    );
  }
  if (report.pinnedSourceChanged || report.routingPolicyChanged) {
    lines.push('  Review the exact migration list, checksums and routing compatibility marker.');
  }
  lines.push(
    `  Screen capacity early if preparation may be needed. The routing table cap is ${report.routingTableScopeGiB} GiB including TOAST.`,
    '  Operator checklist: docs/operations/runbooks/webhook-routing-index.md#early-migration-readiness',
  );
  return lines.join('\n');
}
