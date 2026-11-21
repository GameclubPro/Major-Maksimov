import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// FLAG: The registry, cached profiles and old messages are durable inputs for the rollback image.
export function assertRetiredSuperBanSource(read) {
  const compact = (path) =>
    read(path).replace(
      /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60(?:\\.|[^\x60\\])*\x60)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|\s+/gu,
      (_match, literal) => literal ?? '',
    );
  const mod = (name) => compact('apps/api/src/moderation/' + name);
  const policy = mod('global-spammer-intelligence.service.ts');
  const guard = mod('moderation-state-delete-guard.service.ts');
  const cleanup = mod('moderation-delete-intent.service.ts');
  const cleanupWriter = compact('apps/api/src/admin/admin-manual-message-cleanup.service.ts');
  const recognition = mod('admin-forwarded-command.util.ts');
  const sources = mod('global-spammer-provenance.ts');
  if (
    !cleanupWriter.includes('ordinaryManualCleanupVersion:1') ||
    !cleanup.includes('this.asRecord(reason.metadata)?.ordinaryManualCleanupVersion!==1') ||
    !cleanup.includes('reasons.every((reason)=>this.isUnattributedLegacyManualCleanup(reason))') ||
    !cleanup.includes('!this.isUnattributedLegacyManualCleanup(reason)&&') ||
    !recognition.includes('!normalized||isRetiredSuperBanCommandText(normalized)') ||
    recognition.includes("action:'SUPER_BAN'") ||
    compact('apps/api/src/admin/admin.module.ts').includes('AdminSuperBanProcessor') ||
    compact('apps/api/src/admin/admin.service.legacy.ts').includes(
      'processDeveloperSuperBanJob(',
    ) ||
    mod('moderation.service.legacy.ts').includes('isDeveloperForcedGlobalSpammerCached') ||
    !sources.includes('sources.length>0&&sources.every(isActiveObservationSource)') ||
    sources.includes('DEVELOPER_FORCED') ||
    !/constRUNTIME_PROFILE_SOURCE_VERSION=(?:[3-9]|[1-9][0-9]+);/u.test(policy) ||
    !policy.includes('snapshot.sourceVersion!==RUNTIME_PROFILE_SOURCE_VERSION') ||
    !policy.includes('hasActiveRegistryProvenance(registry.sourceBreakdown)') ||
    !policy.includes('!hasActiveRegistryProvenance(snapshot.sourceBreakdown)') ||
    !guard.includes(
      "this.metadata(reason.metadata).reason==='Developer-forced global blacklist'",
    ) ||
    !guard.includes('this.metadata(latest.metadata).superBan!==true') ||
    !compact('apps/api/src/moderation/reports/report.util.ts').includes(
      '!isRetiredSuperBanCommandText(normalized)',
    )
  )
    throw new Error('Rollback target can reactivate retired developer moderation.');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [sha] = process.argv.slice(2);
    if (!/^[a-f0-9]{40}$/u.test(sha ?? '')) throw new Error('Exact API source SHA required.');
    assertRetiredSuperBanSource((path) =>
      execFileSync('git', ['show', sha + ':' + path], {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
