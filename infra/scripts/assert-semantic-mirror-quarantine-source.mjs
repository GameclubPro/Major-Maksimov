import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const SEMANTIC_MIRROR_QUARANTINE_SOURCE_PATHS = Object.freeze({
  service: 'apps/api/src/webhook/webhook-dependency-quarantine.service.ts',
  schema: 'apps/api/prisma/schema.prisma',
});

function executable(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
}

function method(source, name) {
  const starts = [
    ...source.matchAll(
      new RegExp(`^([\\t ]+)(?:private |public )?(?:async )?${name}\\s*\\(`, 'gmu'),
    ),
  ];
  if (starts.length !== 1) return '';
  const start = starts[0].index;
  const closing = new RegExp(`^${starts[0][1]}\\}`, 'gmu');
  closing.lastIndex = start;
  const end = closing.exec(source);
  return end ? source.slice(start, end.index + end[0].length) : '';
}

function requireFact(value, detail) {
  if (!value)
    throw new Error(`Rollback target lacks typed semantic-mirror quarantine reader: ${detail}`);
}

// FLAG: A status-only reader coerces null <= now to true and expires a semantic mirror.
// Require the actual typed branch before ordered expiry, preserving writer-disabled rollback.
export function assertSemanticMirrorQuarantineSource(readSource) {
  const service = executable(readSource(SEMANTIC_MIRROR_QUARANTINE_SOURCE_PATHS.service));
  const schema = executable(readSource(SEMANTIC_MIRROR_QUARANTINE_SOURCE_PATHS.schema));
  const model = schema.match(/^model\s+WebhookDependencyQuarantine\s*\{([\s\S]*?)^\}/mu)?.[1] ?? '';
  const kinds = schema.match(/^enum\s+WebhookDependencyKind\s*\{([\s\S]*?)^\}/mu)?.[1] ?? '';
  requireFact(
    /\bORDERED\b/u.test(kinds) && /\bSEMANTIC_MIRROR\b/u.test(kinds),
    'persisted dependency kinds',
  );
  requireFact(
    /\bkind\s+WebhookDependencyKind\s+@default\(ORDERED\)/u.test(model),
    'ordered schema default',
  );
  requireFact(
    /\bdeadlineAt\s+DateTime\?\s+@map\("deadline_at"\)/u.test(model),
    'nullable persisted deadline',
  );
  requireFact(
    /export\s+const\s+WEBHOOK_SEMANTIC_MIRROR_QUARANTINE_READER_VERSION\s*=\s*1\s*;/u.test(service),
    'reader version',
  );

  const reconcile = method(service, 'reconcileDue').replace(/\s+/gu, '');
  const semantic = method(service, 'reconcileSemanticMirrorWithClient').replace(/\s+/gu, '');
  const branch =
    /if\(entry\.kind===WebhookDependencyKind\.SEMANTIC_MIRROR\)\{?return(?:await)?this\.reconcileSemanticMirrorWithClient\(tx,entry,receipt\);/u.exec(
      reconcile,
    );
  const ordered =
    /if\(entry\.kind!==WebhookDependencyKind\.ORDERED\|\|!entry\.deadlineAt\)\{?return'waiting';/u.exec(
      reconcile,
    );
  const expiry = reconcile.indexOf('entry.deadlineAt<=now');
  requireFact(
    branch && ordered && branch.index < ordered.index && ordered.index < expiry,
    'semantic dispatch before ordered deadline expiry',
  );
  requireFact(
    /if\(entry\.deadlineAt!==null\|\|receipt\.executionDeadlineAt!==null(?:\|\|[^;]+)?\)\{?return'waiting';/u.test(
      semantic,
    ),
    'semantic null-deadline guard',
  );
  requireFact(
    semantic.includes("owner.status!=='PROCESSED'") &&
      semantic.includes('!owner.processedAt') &&
      semantic.includes('owner.errorMessage!==null') &&
      semantic.includes('owner.nextEnqueueAt!==null') &&
      semantic.includes('owner.timeoutQuarantineExpiresAt!==null'),
    'clean source outcome',
  );
  requireFact(
    semantic.includes("completed.status!=='COMPLETED'") &&
      semantic.includes('!completed.enforced') &&
      semantic.includes('completed.webhookEventId!==owner.id') &&
      semantic.includes('completed.leaseToken!==null') &&
      semantic.includes('completed.leaseExpiresAt!==null'),
    'exact completed execution proof',
  );
  requireFact(
    semantic.includes('execution_deadline_atISNULL') && semantic.includes("status='QUARANTINED'"),
    'deadline-free locked receipt transition',
  );
  requireFact(
    !semantic.includes("'EXPIRED'") &&
      !/execution_deadline_at(?:>|=)|entry\.deadlineAt<=/u.test(semantic),
    'semantic mirrors never acquire or expire a deadline',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const sha = process.argv[2];
    if (!/^[0-9a-f]{40}$/u.test(sha ?? '')) throw new Error('Expected an exact source SHA');
    assertSemanticMirrorQuarantineSource((path) =>
      execFileSync('git', ['show', `${sha}:${path}`], {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
