import { writeSync } from 'node:fs';

// FLAG: This helper belongs only to the isolated audit test harness. Keep the
// existing failure payload and hard exit; production and subprocess limits are
// independent. The argument allows short child fixtures without environment knobs.
export function armAuditFixtureInactivityWatchdog(timeoutMs = 120_000) {
  let activeTestName = 'module_setup';
  let activeTestStartedAt = Date.now();
  const timer = setTimeout(() => {
    writeSync(
      2,
      `${JSON.stringify({
        failure: 'audit_fixture_file_deadline',
        test: activeTestName,
        testElapsedMs: Date.now() - activeTestStartedAt,
        activeResources: process.getActiveResourcesInfo(),
      })}\n`,
    );
    process.exit(1);
  }, timeoutMs).unref();

  return {
    markProgress(testName) {
      activeTestName = testName;
      activeTestStartedAt = Date.now();
      timer.refresh();
    },
  };
}
