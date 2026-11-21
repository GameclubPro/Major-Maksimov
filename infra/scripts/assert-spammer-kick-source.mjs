import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MODERATION = 'apps/api/src/moderation/';
const WORKER = MODERATION + 'moderation-rule-followup.service.ts';
const EXECUTION = MODERATION + 'spammer-kick-followup.ts';
const WRITER = MODERATION + 'spammer-kick-followup-writer.ts';
const INGRESS = MODERATION + 'moderation.service.legacy.ts';

const uncomment = (source) => source.replace(/\/\*[\s\S]*?\*\/|^[ \t]*\/\/[^\r\n]*/gmu, '');
const compact = (source) => uncomment(source).replace(/\s+/gu, '');

export function spammerKickSourceMode(read) {
  const execution = read(EXECUTION);
  const writer = read(WRITER);
  if (execution === null && writer === null) return 'legacy';

  const worker = compact(read(WORKER) ?? '');
  const ingress = compact(read(INGRESS) ?? '');
  const reader = compact(execution ?? '');
  if (
    !worker.includes("from'./spammer-kick-followup'") ||
    !worker.includes('isSpammerKickRule(row.ruleCode)') ||
    !worker.includes('awaitexecutor.executeSpammerKickFollowup(row,leaseToken,receiptOnly)') ||
    !ingress.includes("from'./spammer-kick-followup'") ||
    !ingress.includes('returnexecuteSpammerKickFollowup(row,leaseToken,receiptOnly,') ||
    !reader.includes('exportasyncfunctionexecuteSpammerKickFollowup(') ||
    !reader.includes('exportfunctionspammerMessageKickKey(') ||
    !reader.includes("getExplicitActionJobId('KICK_MEMBER',") ||
    !reader.includes('moderationDeleteVerified') ||
    !reader.includes("'KICK_STARTED'") ||
    !reader.includes("'UNKNOWN'")
  ) {
    throw new Error('API source cannot continue deferred spammer removals.');
  }
  if (writer === null) return 'reader';

  const producer = uncomment(writer);
  const marker = /^export const SPAMMER_KICK_FOLLOWUP_WRITES = true;$/gmu;
  if (
    [...producer.matchAll(marker)].length !== 1 ||
    !compact(producer).includes('ensureIntentWithRuleFollowup(') ||
    !ingress.includes("from'./spammer-kick-followup-writer'") ||
    !ingress.includes('awaitpersistSpammerKickFollowup(')
  ) {
    throw new Error('API source has an incomplete deferred spammer removal writer.');
  }
  return 'writer';
}

function gitRead(sha, path) {
  const options = { encoding: 'utf8', maxBuffer: 4 * 1024 ** 2, stdio: ['ignore', 'pipe', 'pipe'] };
  if (!execFileSync('git', ['ls-tree', '--name-only', sha, '--', path], options).trim()) {
    return null;
  }
  return execFileSync('git', ['show', [sha, path].join(':')], options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [sha] = process.argv.slice(2);
    if (process.argv.length !== 3 || !/^[0-9a-f]{40}$/u.test(sha ?? '')) {
      throw new Error('Exact API source SHA required.');
    }
    console.log(spammerKickSourceMode((path) => gitRead(sha, path)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
