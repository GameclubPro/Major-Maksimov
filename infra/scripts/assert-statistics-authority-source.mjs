import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// FLAG: Superseded authorities outlive flags and image rollback. A migration
// directory or version marker alone cannot establish compatible readers/writers.
export const STATISTICS_AUTHORITY_SOURCE_CHECKS = Object.freeze([
  [
    'packages/contracts/src/statistics-central.ts',
    ['export const STATISTICS_AUTHORITY_LIFECYCLE_VERSION = 2 as const;'],
  ],
  [
    'packages/contracts/src/statistics-central-validation.ts',
    [
      'supersedes: z.object({ id: uuid, revision: positive, epoch: positive }).strict().optional()',
      'export const statsAuthorityResolveRequestSchema = typed<StatsAuthorityResolveRequest>(',
    ],
  ],
  [
    'apps/api/src/statistics/stats-access.service.ts',
    [
      "!r.superseded_by && r.state === 'ACTIVE' && r.peer_valid_until.getTime() > Date.now()",
      "if (old?.superseded_by) return reply('SUPERSEDED', old);",
      "head.state !== 'REVOKED'",
      'op.supersedes?.id !== head.id',
      'op.supersedes.revision !== head.revision.toString()',
      'op.supersedes.epoch !== head.epoch.toString()',
      'UPDATE stats_authorities SET superseded_by=${op.id}::uuid,superseded_at=now()',
      'predecessor.superseded_by !== old.id',
      'AND a.superseded_by IS NULL LIMIT 1',
      '!active(r)',
      '!active(c)',
    ],
  ],
  [
    'apps/api/src/statistics/stats.controller.ts',
    [
      '@UseGuards(StatsGuard)',
      "@Post('authorities:resolve')",
      'this.access.resolve(this.parse(statsAuthorityResolveRequestSchema, body,',
    ],
  ],
  [
    'apps/api/prisma/migrations/20261029193000_statistics_authority_successors/migration.sql',
    [
      'ADD COLUMN superseded_by uuid',
      'ADD COLUMN superseded_at timestamptz(6)',
      "superseded_by <> id AND state = 'REVOKED'",
      'FOREIGN KEY (superseded_by)',
      'REFERENCES stats_authorities(id) ON DELETE NO ACTION ON UPDATE NO ACTION',
      'DEFERRABLE INITIALLY DEFERRED NOT VALID',
      'IF OLD.superseded_by IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN',
      "RAISE EXCEPTION 'Superseded statistics authority is immutable' USING ERRCODE = '23514'",
      'CREATE TRIGGER statistics_authority_successor_immutable BEFORE UPDATE ON stats_authorities',
      'FOR EACH ROW EXECUTE FUNCTION protect_statistics_authority_successor()',
    ],
  ],
  [
    'apps/api/prisma/migrations/20261029193100_index_statistics_authority_heads/migration.sql',
    [
      'CREATE UNIQUE INDEX CONCURRENTLY stats_authorities_current_scope_key',
      'ON stats_authorities(issuer,role,entity_id,producer,consumer,actor_max_id,bot_ref,purpose)',
      'WHERE superseded_by IS NULL',
    ],
  ],
  [
    'apps/api/prisma/migrations/20261029193200_enable_statistics_authority_successors/migration.sql',
    ['ALTER TABLE stats_authorities DROP CONSTRAINT stats_authorities_scope_key'],
  ],
  [
    'infra/scripts/lib/deploy-topology.sh',
    [
      'maxim_topology_require_statistics_authority_lifecycle() {',
      '/../assert-statistics-authority-source.mjs" "$commit_sha"',
      'maxim_topology_require_statistics_and_night_mode_recovery() { local commit_sha="$1" maxim_topology_require_statistics_authority_lifecycle "$commit_sha" || return $? maxim_topology_require_night_mode_recovery_reader "$commit_sha" || return $? }',
    ],
  ],
  [
    'infra/scripts/vps-runtime-rollback.sh',
    ['maxim_topology_require_statistics_and_night_mode_recovery "$TARGET_FULL_SHA"'],
  ],
  [
    'infra/scripts/vps-release-rollback.sh',
    ['maxim_topology_require_statistics_and_night_mode_recovery "$API_SOURCE_SHA"'],
  ],
  [
    'infra/scripts/vps-pull-build-up.sh',
    [
      'maxim_topology_require_statistics_authority_lifecycle "$(git rev-parse "origin/$BRANCH")" || return 2',
      'maxim_topology_require_statistics_authority_lifecycle "$(git rev-parse "refs/heads/$BRANCH")" || return 2',
      'maxim_topology_require_statistics_authority_lifecycle "$TARGET_SHA"',
    ],
  ],
  [
    'infra/scripts/vps-connect.sh',
    ['capability_marker=maxim_topology_require_local_chat_ban_reader'],
  ],
  [
    'infra/scripts/assert-statistics-authority-source.mjs',
    [
      'export function assertStatisticsAuthoritySource(',
      'assertStatisticsAuthoritySource(process.argv[2]);',
    ],
  ],
]);

const executable = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*(?:\/\/|--|#).*$/gmu, '')
    .replace(/\s+/gu, '');

export function assertStatisticsAuthoritySource(
  commitSha,
  readSource = (path) =>
    execFileSync('git', ['show', `${commitSha}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
) {
  if (!/^[0-9a-f]{40}$/u.test(commitSha ?? '')) throw new Error('Exact source SHA required');
  for (const [path, fragments] of STATISTICS_AUTHORITY_SOURCE_CHECKS) {
    let source;
    try {
      source = readSource(path);
    } catch {
      throw new Error(`Candidate lacks statistics authority lifecycle v2 readers/writers: ${path}`);
    }
    const normalized =
      typeof source === 'string' && source.length <= 1024 * 1024 ? executable(source) : '';
    if (fragments.some((fragment) => !normalized.includes(executable(fragment))))
      throw new Error(`Candidate lacks statistics authority lifecycle v2 readers/writers: ${path}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertStatisticsAuthoritySource(process.argv[2]);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
