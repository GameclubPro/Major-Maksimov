import { runNightModeNoticeAuditCli } from './audit-night-mode-close-notices';

// FLAG: Missing historical evidence never authorizes a new CLOSE. The old entry point only audits.
export function legacyNightModeAuditArgs(argv: readonly string[]): string[] {
  return [
    '--page-size',
    '100',
    '--max-chats',
    '100',
    '--sample-limit',
    '0',
    ...argv
      .filter((arg) => arg !== '--dry-run')
      .map((arg) => (arg === '--limit' ? '--max-chats' : arg)),
  ];
}

if (require.main === module) {
  runNightModeNoticeAuditCli(legacyNightModeAuditArgs(process.argv.slice(2)));
}
