import { dirname, relative, resolve } from 'node:path';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { findContractsArchitectureViolations } from './check-contract-exports.mjs';
import { assertRuntimeContextBoundaries } from './check-runtime-contexts.mjs';

const root = resolve(import.meta.dirname, '..');

const guardedFiles = [
  {
    path: 'apps/miniapp/src/pages/publications-page.tsx',
    maxLines: 2017,
    targetLines: 1900,
    reason:
      'This ceiling includes only the late-policy component wiring; policy controls remain in a focused component. Publication list filters, cursor queries and calendar range now have dedicated controllers; the page should continue separating editor lifecycle and action confirmations.',
  },
  {
    path: 'apps/api/src/admin/admin.service.legacy.ts',
    maxLines: 22777,
    targetLines: 22500,
    reason:
      'AdminService remains a legacy hotspot; the three-line lazy dialog-context bridge keeps per-target preparation in a focused helper; this ceiling includes the shared crash-safe Major/Publisher suggestion delivery ledger and sanction lock/fence guards at existing side-effect boundaries, while unrelated domains should keep moving to focused services.',
  },
  {
    path: 'apps/api/src/admin/admin-managed-broadcast-runtime.ts',
    maxLines: 6467,
    targetLines: 6200,
    reason:
      'Managed broadcast coordination should keep media, scheduling, reconciliation, and presentation policy in focused collaborators.',
  },
  {
    path: 'apps/api/src/admin/admin.service.spec.ts',
    maxLines: 31648,
    targetLines: 30000,
    reason:
      'AdminService tests should keep moving by complete domain into focused specs instead of regrowing the legacy all-domain test file.',
  },
  {
    path: 'apps/api/src/admin/admin-service-test-support.ts',
    maxLines: 1889,
    targetLines: 1600,
    reason:
      'Shared AdminService test builders should remain a focused harness instead of becoming another all-domain fixture dump.',
  },
  {
    path: 'apps/admin/src/admin-app.tsx',
    maxLines: 580,
    targetLines: 520,
    reason:
      'Safety Desk route/controller state should stay separate from focused review, support, and delete presentation modules.',
  },
  {
    path: 'apps/api/src/moderation/moderation.service.legacy.ts',
    maxLines: 18673,
    targetLines: 17000,
    reason:
      'ModerationService remains a legacy hotspot; this ceiling includes crash-fenced webhook timeout settlement, the Karavan policy handoff, ordered predecessor deferral, thin participant-report admission/counter hooks, and the voice-source evidence binding call. Report state, voice capture/revocation and deletion authorization remain in focused services.',
  },
  {
    path: 'apps/api/src/moderation/private-control.service.legacy.ts',
    maxLines: 9273,
    targetLines: 9000,
    reason:
      'PrivateControlService retains callback and session orchestration; settings search, summaries, value formatting and callback rows now live in pure rendering modules and must not return here.',
  },
  {
    path: 'apps/miniapp/src/pages/settings-page.legacy.tsx',
    maxLines: 7412,
    targetLines: 7000,
    reason:
      'SettingsPage remains a legacy shell; the one-line closure-status prop delegates presentation to the night section; this ceiling includes the photo-duplicate mode plumbing and the scoped Karavan storefront allowlist section bridge into focused settings modules, while route state and workspaces should continue moving out.',
  },
  {
    path: 'apps/miniapp/src/styles/settings-native-controls.css',
    maxLines: 379,
    targetLines: 300,
    reason:
      'Shared settings native controls should stay focused instead of becoming a route compatibility bundle.',
  },
  {
    path: 'apps/miniapp/src/styles/settings-home-compact.css',
    maxLines: 308,
    targetLines: 250,
    reason:
      'Compact settings home and channel card styles should stay route-owned instead of returning to the lazy compatibility bundle.',
  },
  {
    path: 'apps/miniapp/src/styles/settings-home-route-polish.css',
    maxLines: 597,
    targetLines: 430,
    reason:
      'Settings home shell polish should stay route-owned instead of returning to broad settings route CSS.',
  },
  {
    path: 'apps/miniapp/src/styles/settings-rules-studio.css',
    maxLines: 270,
    targetLines: 220,
    reason:
      'Rules studio styles should stay route-owned instead of returning to the lazy compatibility bundle.',
  },
  {
    path: 'apps/miniapp/src/styles/broadcast-studio-base.css',
    maxLines: 1068,
    targetLines: 900,
    reason:
      'Broadcast studio base styles should stay route-owned instead of returning to the lazy compatibility bundle.',
  },
  {
    path: 'apps/miniapp/src/styles/settings-policy-controls.css',
    maxLines: 316,
    targetLines: 250,
    reason:
      'Settings policy/control island styles should stay route-owned instead of returning to the lazy compatibility bundle.',
  },
  {
    path: 'apps/miniapp/src/styles/settings-link-allowlist.css',
    maxLines: 533,
    targetLines: 420,
    reason:
      'Link allowlist styles should stay route-owned instead of returning to the lazy compatibility bundle.',
  },
  {
    path: 'apps/miniapp/src/pages/settings-page.css',
    maxLines: 297,
    targetLines: 330,
    reason:
      'Settings route-owned CSS should stay focused while legacy settings page markup is extracted.',
  },
  {
    path: 'apps/miniapp/src/pages/settings/settings-duplicate-stage.css',
    maxLines: 127,
    targetLines: 95,
    reason:
      'Duplicate moderation stage styles should stay with the settings duplicate panel owner.',
  },
  {
    path: 'apps/miniapp/src/components/ui/segmented-control.css',
    maxLines: 46,
    targetLines: 40,
    reason:
      'SegmentedControl base styles should stay component-owned while route-specific sizing stays scoped.',
  },
  {
    path: 'apps/miniapp/src/components/ui/toast.css',
    maxLines: 65,
    targetLines: 52,
    reason:
      'Toast portal styles should stay component-owned while route-specific placement overrides stay scoped.',
  },
  {
    path: 'apps/miniapp/src/components/managed-broadcast-history-card.css',
    maxLines: 240,
    targetLines: 190,
    reason:
      'ManagedBroadcastHistoryCard styles should stay component-owned while route density overrides stay scoped.',
  },
  {
    path: 'apps/miniapp/src/components/managed-broadcast-delivery-meter.css',
    maxLines: 92,
    targetLines: 60,
    reason:
      'ManagedBroadcastDeliveryMeter styles should stay component-owned instead of returning to broadcast route CSS.',
  },
  {
    path: 'apps/miniapp/src/components/broadcast-schedule-planner.css',
    maxLines: 2065,
    targetLines: 1500,
    reason:
      'BroadcastSchedulePlanner base styles should stay component-owned instead of returning to lazy route CSS.',
  },
  {
    path: 'apps/miniapp/src/components/chat-onboarding-section.css',
    maxLines: 153,
    targetLines: 72,
    reason:
      'Chat onboarding empty-state styles should stay with the lazy-loaded onboarding component.',
  },
  {
    path: 'apps/miniapp/src/components/max-markdown-editor.css',
    maxLines: 114,
    targetLines: 90,
    reason:
      'MaxMarkdownEditor styles should stay component-owned and avoid leaking back into lazy route CSS.',
  },
  {
    path: 'apps/miniapp/src/components/max-rich-text-editor.css',
    maxLines: 210,
    targetLines: 115,
    reason:
      'MaxRichTextEditor base styles should stay component-owned and route overrides should stay scoped.',
  },
  {
    path: 'apps/miniapp/src/components/ui/action-confirm-sheet.css',
    maxLines: 205,
    targetLines: 150,
    reason:
      'ActionConfirmSheet is a portal component; its sheet styles should stay component-owned.',
  },
  {
    path: 'apps/miniapp/src/components/bot-speech-message-editor-sheet.css',
    maxLines: 436,
    targetLines: 260,
    reason: 'Bot speech editor sheet styles should stay with the lazy-loaded sheet component.',
  },
  {
    path: 'apps/miniapp/src/styles/settings-drilldown-core.css',
    maxLines: 1334,
    targetLines: 1100,
    reason:
      'Settings drilldown core CSS should own shell-scoped overrides without becoming another route dump.',
  },
  {
    path: 'apps/miniapp/src/styles/components.css',
    maxLines: 1561,
    targetLines: 1350,
    reason:
      'Startup shared styles should stay focused on primitives; route-specific home styles should move to route/component CSS.',
  },
  {
    path: 'apps/miniapp/src/styles/settings-duration-editor.css',
    maxLines: 235,
    targetLines: 160,
    reason:
      'Settings duration editor CSS should stay focused and avoid returning to the lazy route bundle.',
  },
  {
    path: 'apps/miniapp/src/components/dashboard/membership-activity-feed.css',
    maxLines: 586,
    targetLines: 520,
    reason:
      'Membership activity feed styles should stay component-owned after moving its base and responsive rules out of dashboard-events.css.',
  },
  {
    path: 'apps/miniapp/src/components/dashboard/chat-participants-roster.css',
    maxLines: 576,
    targetLines: 500,
    reason:
      'Chat participants roster styles should stay component-owned after moving its base and responsive rules out of dashboard-events.css.',
  },
  {
    path: 'apps/miniapp/src/components/dashboard/chat-participant-sheet.css',
    maxLines: 581,
    targetLines: 500,
    reason:
      'Chat participant sheet styles should stay component-owned after moving its base and responsive rules out of dashboard-events.css.',
  },
  {
    path: 'apps/miniapp/src/components/dashboard/dashboard-hero.css',
    maxLines: 138,
    targetLines: 120,
    reason:
      'DashboardHero styles should stay component-owned instead of returning to dashboard-events.css.',
  },
  {
    path: 'apps/miniapp/src/components/required-subscription-source-picker.css',
    maxLines: 581,
    targetLines: 300,
    reason:
      'RequiredSubscriptionSourcePicker styles should stay component-owned instead of returning to managed-giveaway route CSS.',
  },
  {
    path: 'apps/miniapp/src/components/broadcast-studio-header.css',
    maxLines: 148,
    targetLines: 130,
    reason:
      'BroadcastStudioChecklist styles should stay component-owned instead of returning to broadcast route CSS.',
  },
  {
    path: 'apps/miniapp/src/components/message-limits-blocked-word-presets.css',
    maxLines: 251,
    targetLines: 170,
    reason:
      'MessageLimitsBlockedWordPresets styles should stay component-owned instead of returning to lazy route CSS.',
  },
  {
    path: 'apps/miniapp/src/styles/channel-dialog-image-viewer.css',
    maxLines: 203,
    targetLines: 180,
    reason: 'Channel dialog image viewer CSS should remain a focused route-owned lightbox slice.',
  },
  {
    path: 'apps/miniapp/src/styles/channel-stats.css',
    maxLines: 2954,
    targetLines: 2400,
    reason:
      'Channel stats owner CSS should stay scoped and avoid becoming another compatibility bundle.',
  },
  {
    path: 'apps/miniapp/src/styles/settings-route-polish.css',
    maxLines: 5065,
    targetLines: 3300,
    reason:
      'Settings route polish should keep shrinking into scoped route sections and component-owned styles.',
  },
  {
    path: 'apps/miniapp/src/styles/broadcast-studio.css',
    maxLines: 5128,
    targetLines: 3660,
    reason: 'Broadcast composer/planner/history styles should keep moving to component-owned CSS.',
  },
  {
    path: 'apps/miniapp/src/styles/dashboard-events.css',
    maxLines: 4017,
    targetLines: 3600,
    reason:
      'Dashboard feed, participant sheet, and stats primitives should keep moving to scoped component CSS; owner CSS may carry local bases removed from shared bundles.',
  },
  {
    path: 'apps/miniapp/src/styles/channel-dialog-comments.css',
    maxLines: 4068,
    targetLines: 4200,
    reason:
      'Channel dialog route CSS should stay scoped and continue shrinking into focused dialog components.',
  },
  {
    path: 'packages/contracts/src/core.ts',
    maxLines: 2733,
    targetLines: 2500,
    reason:
      'Core retains chat settings composition; closure diagnostics have their own schema module with only import/response wiring here; this ceiling includes separate profanity message fields and commercial photo availability alongside the focused photo-duplicate integration. Reusable commercial thresholds and sanction-ladder policy live in commercial-settings.ts; new reusable schemas should continue moving to subpath exports.',
  },
  {
    path: 'apps/api/src/admin/publication.service.ts',
    maxLines: 3872,
    targetLines: 3200,
    reason:
      'Publication scheduling, query, and retry logic should keep moving to focused domain services; late-policy and recurrence-resume behavior live in a focused helper, with bounded materialization wiring here.',
  },
  {
    path: 'apps/miniapp/src/pages/publications-page.tsx',
    maxLines: 3020,
    targetLines: 2300,
    reason: 'PublicationsPage should shrink into a route shell, hooks, and focused workspaces.',
  },
  {
    path: 'apps/miniapp/src/styles/publications-page.css',
    maxLines: 2541,
    targetLines: 1900,
    reason:
      'Publication route styles should keep moving to component-owned CSS instead of becoming a compatibility bundle.',
  },
];

const allowedLegacyImportFiles = new Set([
  'apps/api/src/admin/admin.service.impl.ts',
  'apps/api/src/admin/admin.service.ts',
  'apps/api/src/moderation/moderation.service.impl.ts',
  'apps/api/src/moderation/moderation.service.ts',
  'apps/api/src/moderation/private-control.service.ts',
  'apps/miniapp/src/pages/settings-page.tsx',
]);

const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const ignoredDirectoryNames = new Set(['.git', 'coverage', 'dist', 'node_modules']);
const legacyImportPattern =
  /\b(?:import|export)\b[\s\S]*?\bfrom\s+['"][^'"]*\.legacy(?:\.[^'"]+)?['"]|import\s*\(\s*['"][^'"]*\.legacy(?:\.[^'"]+)?['"]\s*\)/u;
const importStatementPattern =
  /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/gu;
const typeOnlyImportStatementPattern = /^\s*(?:import|export)\s+type\b/u;
const productionSourcePathPattern =
  /^(?:apps|packages)\/[^/]+\/src\/(?!generated\/).*?\.(?:ts|tsx|js|mjs|cjs)$/u;
const testSourcePathPattern = /(?:^|\/)(?:test|__tests__)\/|(?:\.spec|\.test)\.[cm]?[tj]sx?$/u;

const allowedImportCycles = [
  {
    name: 'AdminService temporary legacy facade',
    paths: [
      'apps/api/src/admin/admin.service.ts',
      'apps/api/src/admin/admin.service.impl.ts',
      'apps/api/src/admin/admin.service.legacy.ts',
    ],
  },
  {
    name: 'ModerationService temporary legacy facade',
    paths: [
      'apps/api/src/moderation/moderation.service.ts',
      'apps/api/src/moderation/moderation.service.impl.ts',
      'apps/api/src/moderation/moderation.service.legacy.ts',
    ],
  },
  {
    name: 'PrivateControlService temporary legacy facade',
    paths: [
      'apps/api/src/moderation/private-control.service.ts',
      'apps/api/src/moderation/private-control.service.legacy.ts',
    ],
  },
  {
    name: 'SettingsPage temporary legacy facade',
    paths: [
      'apps/miniapp/src/pages/settings-page.tsx',
      'apps/miniapp/src/pages/settings-page.legacy.tsx',
    ],
  },
];

const runtimeEntrypointBoundaryGuards = [
  {
    path: 'apps/api/src/webhook/webhook.controller.ts',
    boundary: 'WebhookIngestionService',
    patterns: [
      {
        pattern: /\bWebhookService\b/u,
        reason:
          'Controllers should keep webhook signature, parsing, rate-limit, and outbox ingestion behind WebhookIngestionService.',
      },
      {
        pattern: /\bWebhookParser\b/u,
        reason: 'Webhook parsing belongs inside the ingestion boundary, not the public controller.',
      },
    ],
  },
  {
    path: 'apps/api/src/max/max-action.processor.ts',
    boundary: 'MaxActionDispatchService',
    patterns: [
      {
        pattern: /\bMaxClientService\b/u,
        reason:
          'Action workers should dispatch through MaxActionDispatchService so MAX API execution can be isolated from processor topology.',
      },
      {
        pattern: /\bexecuteActionJob\s*\(/u,
        reason: 'Action workers should not call MaxClientService.executeActionJob directly.',
      },
    ],
  },
  {
    path: 'apps/api/src/moderation/default-webhook-lease-manager.service.ts',
    boundary: 'ModerationExecutionService',
    patterns: [
      {
        pattern: /\bModerationService\b/u,
        reason:
          'Dynamic moderation workers should execute through ModerationExecutionService instead of depending on the legacy moderation service.',
      },
      {
        pattern: /\bmoderationService\.processWebhookEvent\s*\(/u,
        reason:
          'Dynamic moderation workers should call ModerationExecutionService.processWebhookEvent.',
      },
    ],
  },
  {
    path: 'apps/api/src/admin/admin-managed-entities-refresh.processor.ts',
    boundary: 'ManagedEntitiesDiscoveryService',
    patterns: [
      {
        pattern: /\bAdminService\b/u,
        reason:
          'Managed-entities refresh workers should stay behind the discovery boundary instead of reaching legacy admin directly.',
      },
      {
        pattern: /\bManagedEntitiesService\b/u,
        reason:
          'Managed-entities refresh workers should use ManagedEntitiesDiscoveryService as the runtime discovery boundary.',
      },
      {
        pattern:
          /\b(?:adminService|managedEntitiesService)\.processManagedEntitiesRefreshJob\s*\(/u,
        reason:
          'Managed-entities refresh workers should dispatch through ManagedEntitiesDiscoveryService.',
      },
    ],
  },
];

let failed = false;

for (const guard of guardedFiles) {
  const contents = readFileSync(resolve(root, guard.path), 'utf8');
  const lines = countLines(contents);
  if (lines <= guard.maxLines) {
    continue;
  }

  failed = true;
  console.error(
    [
      `${guard.path} has ${lines} lines, over the ${guard.maxLines} refactor guard.`,
      guard.reason,
      `Next target: ${guard.targetLines} lines or fewer.`,
      'If this growth is intentional, update the guard in the same change with the architectural reason.',
    ].join('\n'),
  );
}

for (const violation of findLegacyImportViolations(root)) {
  failed = true;
  console.error(
    [
      `${violation.path} imports a *.legacy module directly.`,
      'Legacy modules must stay hidden behind their thin facade files so future extraction work has one stable boundary.',
      `Allowed facade files: ${Array.from(allowedLegacyImportFiles).join(', ')}`,
    ].join('\n'),
  );
}

for (const violation of findRuntimeEntrypointBoundaryViolations(root)) {
  failed = true;
  console.error(
    [
      `${violation.path} bypasses ${violation.boundary}.`,
      violation.reason,
      'Route new runtime/admin hot-path code through the focused boundary service before touching legacy implementations.',
    ].join('\n'),
  );
}

for (const violation of findImportCycleViolations(root)) {
  failed = true;
  console.error(
    [
      `Import cycle detected: ${violation.cycle.join(' -> ')}`,
      'Production modules should stay acyclic so extraction work can move code behind stable boundaries.',
      `Allowed temporary facade cycles: ${allowedImportCycles.map((cycle) => cycle.name).join(', ')}`,
    ].join('\n'),
  );
}

for (const violation of findContractsArchitectureViolations(root)) {
  failed = true;
  console.error(
    [
      violation.message,
      'Keep packages/contracts package exports, root TS paths, and API Jest mappers exact and aligned.',
      'Generated contract JS must live under dist/, not tracked src/.',
    ].join('\n'),
  );
}

try {
  assertRuntimeContextBoundaries(root);
} catch (error) {
  failed = true;
  console.error(error.message);
}

if (failed) {
  process.exitCode = 1;
}

function countLines(value) {
  if (!value) {
    return 0;
  }

  return value.split(/\r?\n/u).length - (value.endsWith('\n') ? 1 : 0);
}

function findLegacyImportViolations(directory) {
  const violations = [];

  for (const filePath of walkSourceFiles(directory)) {
    const repoPath = toRepoPath(filePath);
    if (allowedLegacyImportFiles.has(repoPath)) {
      continue;
    }

    const contents = readFileSync(filePath, 'utf8');
    if (legacyImportPattern.test(contents)) {
      violations.push({ path: repoPath });
    }
  }

  return violations;
}

function findRuntimeEntrypointBoundaryViolations(directory) {
  const violations = [];

  for (const guard of runtimeEntrypointBoundaryGuards) {
    const filePath = resolve(directory, guard.path);
    const contents = readFileSync(filePath, 'utf8');
    for (const item of guard.patterns) {
      if (item.pattern.test(contents)) {
        violations.push({
          path: guard.path,
          boundary: guard.boundary,
          reason: item.reason,
        });
      }
    }
  }

  return violations;
}

function findImportCycleViolations(directory) {
  const sourceFiles = walkSourceFiles(directory)
    .filter((filePath) => isProductionSourceFile(toRepoPath(filePath)))
    .map((filePath) => resolve(filePath));
  const sourceFileSet = new Set(sourceFiles);
  const graph = new Map(sourceFiles.map((filePath) => [filePath, []]));

  for (const filePath of sourceFiles) {
    const contents = readFileSync(filePath, 'utf8');
    for (const specifier of findRuntimeImportSpecifiers(contents)) {
      const resolvedImport = resolveLocalSourceImport(filePath, specifier, sourceFileSet);
      if (resolvedImport) {
        graph.get(filePath)?.push(resolvedImport);
      }
    }
  }

  const violations = [];
  const visited = new Set();
  const visiting = new Set();
  const stack = [];
  const seenCycles = new Set();

  for (const filePath of sourceFiles) {
    visit(filePath);
  }

  return violations;

  function visit(filePath) {
    if (visited.has(filePath)) {
      return;
    }
    if (visiting.has(filePath)) {
      return;
    }

    visiting.add(filePath);
    stack.push(filePath);

    for (const dependency of graph.get(filePath) ?? []) {
      if (visiting.has(dependency)) {
        const startIndex = stack.indexOf(dependency);
        if (startIndex < 0) {
          continue;
        }

        const cycle = [...stack.slice(startIndex), dependency].map(toRepoPath);
        const cycleKey = canonicalizeCycle(cycle);
        if (seenCycles.has(cycleKey) || isAllowedImportCycle(cycle)) {
          continue;
        }

        seenCycles.add(cycleKey);
        violations.push({ cycle });
      } else if (!visited.has(dependency)) {
        visit(dependency);
      }
    }

    stack.pop();
    visiting.delete(filePath);
    visited.add(filePath);
  }
}

function findRuntimeImportSpecifiers(contents) {
  const specifiers = [];
  for (const match of contents.matchAll(importStatementPattern)) {
    const statement = match[0];
    if (typeOnlyImportStatementPattern.test(statement)) {
      continue;
    }

    const specifier = match[1] ?? match[2] ?? '';
    if (specifier.startsWith('.')) {
      specifiers.push(specifier);
    }
  }

  return specifiers;
}

function resolveLocalSourceImport(fromFilePath, specifier, sourceFileSet) {
  const basePath = resolve(dirname(fromFilePath), specifier);
  for (const candidate of buildImportCandidates(basePath)) {
    if (sourceFileSet.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

function buildImportCandidates(basePath) {
  const extensions = Array.from(sourceExtensions);
  return [
    basePath,
    ...extensions.map((extension) => `${basePath}${extension}`),
    ...extensions.map((extension) => resolve(basePath, `index${extension}`)),
  ].map((candidate) => resolve(candidate));
}

function canonicalizeCycle(cycle) {
  const uniqueCycle = cycle.slice(0, -1);
  const rotations = uniqueCycle.map((_, index) => [
    ...uniqueCycle.slice(index),
    ...uniqueCycle.slice(0, index),
  ]);
  rotations.sort((left, right) => left.join('\n').localeCompare(right.join('\n')));
  return rotations[0].join(' -> ');
}

function isAllowedImportCycle(cycle) {
  const cyclePaths = new Set(cycle);
  return allowedImportCycles.some((allowedCycle) =>
    allowedCycle.paths.every((filePath) => cyclePaths.has(filePath)),
  );
}

function isProductionSourceFile(repoPath) {
  return productionSourcePathPattern.test(repoPath) && !testSourcePathPattern.test(repoPath);
}

function walkSourceFiles(directory) {
  const entries = readdirSync(directory);
  const files = [];

  for (const entry of entries) {
    const entryPath = resolve(directory, entry);
    const stats = statSync(entryPath);
    if (stats.isDirectory()) {
      if (ignoredDirectoryNames.has(entry)) {
        continue;
      }
      files.push(...walkSourceFiles(entryPath));
      continue;
    }

    if (stats.isFile() && sourceExtensions.has(readExtension(entry))) {
      files.push(entryPath);
    }
  }

  return files;
}

function readExtension(fileName) {
  const index = fileName.lastIndexOf('.');
  return index >= 0 ? fileName.slice(index) : '';
}

function toRepoPath(filePath) {
  return relative(root, filePath).split('\\').join('/');
}
