import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const paths = {
  schema: 'apps/api/prisma/schema.prisma',
  evaluator: 'packages/contracts/src/link-rules-policy.ts',
  reader: 'apps/api/src/moderation/link-rules-policy.runtime.ts',
  detector: 'apps/api/src/moderation/rule-engine-link-detector.ts',
  guard: 'apps/api/src/moderation/link-history-delete-guard.service.ts',
  history: 'apps/api/src/moderation/link-history-recovery.service.ts',
  historySql: 'apps/api/src/moderation/link-rules-history.sql.ts',
  historyUtil: 'apps/api/src/moderation/link-history-recovery.util.ts',
  executor: 'apps/api/src/moderation/moderation-delete-intent.service.ts',
  networkContract: 'packages/contracts/src/network-settings-read.ts',
  networkReader: 'apps/api/src/admin/network-settings.service.ts',
};

function executable(source) {
  return source
    .replace(
      /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/gu,
      (match, literal) => literal ?? '',
    )
    .replace(/\s+/gu, ' ');
}

export function assertLinkRulesSource(read) {
  // FLAG: Persisted selective link rules and queued reasons need compatible readers even
  // after all chats switch to allow-all. The legacy shadow enum cannot authorize a rollback.
  const source = Object.fromEntries(
    Object.entries(paths).map(([key, path]) => [key, executable(read(path))]),
  );
  const valid =
    /linkRulesPolicy\s+Json\?/u.test(source.schema) &&
    source.evaluator.includes('export function evaluateLinkRulesPolicy') &&
    source.reader.includes('linkRulesPolicySchema.safeParse(value)') &&
    source.reader.includes(
      'return evaluateLinkRulesPolicy(policy, targets.filter(isEnforceableLinkPolicyTarget), nowMs)',
    ) &&
    source.detector.includes('readRuntimeLinkRulesPolicy(linkRulesPolicy)') &&
    source.detector.includes('evaluateRuntimeLinkRulesPolicy(rules.policy, targets)') &&
    source.guard.includes('linkRulesPolicy: true') &&
    source.guard.split(
      'reason.linkRulesPolicySha256 === fingerprintLinkRulesPolicy(settings.linkRulesPolicy)',
    ).length === 3 &&
    /isLinkHistoryPolicyViolation\( settings\.linkPolicy, allowlistRows\.map\(\(row\) => row\.domain\), targets, settings\.linkRulesPolicy,? \)/u.test(
      source.guard,
    ) &&
    /isLinkHistoryPolicyViolation\( current\.settings\.linkPolicy, current\.allowlistRows\.map\(\(row\) => row\.domain\), targets, current\.settings\.linkRulesPolicy,? \)/u.test(
      source.guard,
    ) &&
    source.history.includes('linkRulesPolicy: true') &&
    source.history.includes('activeLinkPolicySql()') &&
    source.history.includes('linkPolicySemanticEffectiveAtSql(') &&
    source.historySql.includes('settings."link_rules_policy"') &&
    source.historyUtil.includes('evaluateRuntimeLinkRulesPolicy(') &&
    /this\.linkHistoryDeleteGuard!?\.(?:assertIntentStillActionable|authorizeIntent)\(/u.test(
      source.executor,
    ) &&
    source.networkContract.includes(
      'export const NETWORK_SETTINGS_OPERATION_READER_VERSION = 4;',
    ) &&
    source.networkReader.includes(
      "payload.request.changes.some((change) => change.path === 'linkRulesPolicy') && version < 4",
    ) &&
    source.networkReader.includes(
      "readerVersion: request.changes.some((change) => change.path === 'linkRulesPolicy') ? 4",
    );
  if (!valid)
    throw new Error(
      'Rollback target lacks the selective link policy reader and final delete guards.',
    );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const sha = process.argv[2];
    if (!/^[0-9a-f]{40}$/u.test(sha ?? '')) throw new Error('An exact API source SHA is required.');
    assertLinkRulesSource((path) =>
      execFileSync('git', ['show', `${sha}:${path}`], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Selective link reader check failed.'}\n`,
    );
    process.exitCode = 1;
  }
}
