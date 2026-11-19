import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const service = 'apps/api/src/admin/managed-giveaway.service.ts';
const checks = [
  [service, 'private async findGiveawayForSource(', ['archivedAt: null']],
  [service, 'async getCurrentManagedGiveawayForEntity(', ['archivedAt: null']],
  [
    service,
    'private async lockGiveawayForWinnerMutation(',
    ['archived_at IS NULL', 'FOR NO KEY UPDATE'],
  ],
  [
    service,
    'async rerollManagedGiveawayWinner(',
    ['await this.lockGiveawayForWinnerMutation(tx, giveawayId)'],
  ],
  [
    service,
    'async markManagedGiveawayWinnerDelivered(',
    ['await this.lockGiveawayForWinnerMutation(tx, giveawayId)'],
  ],
  [
    service,
    'async deleteManagedGiveaway(',
    [
      'FOR NO KEY UPDATE',
      'data: { archivedAt: new Date() }',
      "['DISPATCHING', 'AMBIGUOUS']",
      'resultsSync: { nextAttemptAt: null, leaseToken: null }',
    ],
  ],
  [
    service,
    'async processDueManagedGiveaways(',
    [
      'this.prisma.managedGiveawayResultsSync.findMany(',
      'giveaway: { archivedAt: null }',
      "await this.syncGiveawayResults(giveawayId, 'runner')",
    ],
  ],
  [
    service,
    'private async syncGiveawayResults(',
    ['processGiveawayResultsSync(this.prisma, giveawayId,', 'this.republishGiveawayResults('],
  ],
  [
    'apps/api/src/admin/managed-giveaway-read-model.ts',
    'export async function readGiveawayHistoryPage(',
    ['WHERE archived_at IS NULL'],
  ],
  [
    'apps/api/src/admin/managed-giveaway-results-sync.ts',
    'export async function processGiveawayResultsSync(',
    [
      "giveaway: { status: 'COMPLETED', archivedAt: null }",
      'const owned = { ...eligible, revision, leaseToken }',
      'if (!(await publish(assertCurrent))) return false;',
      'where: { ...owned, leaseUntil: { gt: new Date() } }',
      'data: { nextAttemptAt: null, leaseToken: null, leaseUntil: null, attempts: 0 }',
    ],
  ],
];

export function assertManagedGiveawaySource(
  sha,
  read = (path) =>
    execFileSync('git', ['show', `${sha}:${path}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
) {
  if (!/^[0-9a-f]{40}$/u.test(sha ?? '')) throw new Error('Exact API source SHA required');
  const sources = new Map();
  for (const [path, method, terms] of checks) {
    if (!sources.has(path))
      sources.set(path, read(path).replace(/\/\*[\s\S]*?\*\/|^[ \t]*(?:\/\/|--).*$/gmu, ''));
    const source = sources.get(path);
    const start = source.indexOf(method);
    const body =
      start < 0
        ? ''
        : source
            .slice(start)
            .split(/\n(?: {2}(?:private |async )|export (?:async )?function )/u, 1)[0]
            .replace(/\s+/gu, '');
    if (terms.some((term) => !body.includes(term.replace(/\s+/gu, '')))) {
      throw new Error(
        `Rollback API source lacks giveaway archive or results-sync handling in ${method} (${path})`,
      );
    }
  }
}

export function giveawayResultsWriterMode(sha) {
  if (!/^[0-9a-f]{40}$/u.test(sha ?? '')) throw new Error('Exact API source SHA required');
  const path = 'apps/api/src/admin/managed-giveaway-results-sync.ts';
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
  if (!git('ls-tree', '--name-only', sha, '--', path).trim()) return 'legacy';
  const source = git('show', `${sha}:${path}`).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gmu, '');
  const markers = [
    ...source.matchAll(/^export const MANAGED_GIVEAWAY_RESULTS_SYNC_ACTIVATED = (true|false);$/gmu),
  ];
  if (markers.length !== 1) throw new Error('Giveaway results writer mode is missing or ambiguous');
  return markers[0][1] === 'true' ? 'writer' : 'reader';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[3] === '--writer-mode')
      console.log(giveawayResultsWriterMode(process.argv[2]));
    else assertManagedGiveawaySource(process.argv[2]);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
