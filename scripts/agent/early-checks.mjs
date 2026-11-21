import { resolve } from 'node:path';

const previewArchitecture = 'apps/miniapp/test/preview-transport-architecture.test.ts';
const releaseSourceFloor = 'infra/scripts/release-service-source-floor.test.mjs';
const rollbackPlan = 'infra/scripts/release-rollback-plan.test.mjs';
const nightModeRollback = 'infra/scripts/night-mode-recovery-rollback.test.mjs';
const spammerKickFloor = 'infra/scripts/spammer-kick-source-guard.test.mjs';
const sourceInventory = 'apps/api/src/scripts/source-abandonment-sql-row.spec.ts';
const requiredSubscription =
  'apps/api/src/moderation/moderation.service.required-subscription.spec.ts';

const rules = [
  [
    /^apps\/miniapp\/src\/lib\/api\/preview-(?:transport(?:[-.]|\/)|chat-closure\.ts$|stop-words\.ts$)/u,
    [previewArchitecture],
  ],
  [
    /^infra\/scripts\/(?:vps-connect\.sh|vps-(?:release|runtime)-rollback\.sh|lib\/deploy-lock\.sh|release-service-source-floor\.mjs)$/u,
    [releaseSourceFloor],
  ],
  [
    /^infra\/scripts\/(?:vps-connect\.sh|vps-(?:release|runtime)-rollback\.sh|lib\/deploy-topology\.sh)$/u,
    [
      rollbackPlan,
      nightModeRollback,
      spammerKickFloor,
      'infra/scripts/legacy-cold-entrypoint-guards.test.mjs',
      'infra/scripts/bot-publisher-reliability-rollback.test.mjs',
    ],
  ],
  [
    /^(?:infra\/scripts\/assert-night-mode-recovery-source\.mjs|apps\/api\/src\/moderation\/night-mode-[^/]+\.ts)$/u,
    [nightModeRollback],
  ],
  [
    /^(?:infra\/scripts\/assert-spammer-kick-source\.mjs|apps\/api\/src\/moderation\/spammer-kick-[^/]+\.ts)$/u,
    [spammerKickFloor],
  ],
  [
    /^apps\/api\/(?:prisma\/schema\.prisma|src\/scripts\/source-abandonment-sql-row\.ts)$/u,
    [sourceInventory],
  ],
  [
    /^apps\/api\/src\/moderation\/(?:spammer-kick-[^/]+\.ts|moderation\.service\.legacy\.ts|moderation-state-delete-guard\.service\.ts)$/u,
    [requiredSubscription],
  ],
];

export function selectEarlyTests(changedPaths) {
  const tests = new Set();
  for (const path of changedPaths) {
    for (const [pattern, candidates] of rules) {
      if (pattern.test(path)) candidates.forEach((test) => tests.add(test));
    }
  }
  return [...tests].sort();
}

export async function selectEarlyCommands(root, changedPaths) {
  const tests = selectEarlyTests(changedPaths);
  if (!tests.length) return [];

  const { selectFocusedCommands } = await import('./focused.mjs');
  const commands = await selectFocusedCommands(resolve(root), tests);
  // FLAG: Automatic preflight must stay local. Tests that require stores have a separate
  // public focused runner and may not inherit a database URL from a developer shell here.
  if (commands.some(({ requiredEnvironment }) => requiredEnvironment.length)) {
    throw new Error('An early check requires test stores. Move it to the native focused lane.');
  }
  return commands.map((command) => ({ ...command, id: `early-${command.id}` }));
}
