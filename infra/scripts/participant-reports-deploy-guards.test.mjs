import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const paths = {
  guard: 'apps/api/src/moderation/reports/report-delete-guard.service.ts',
  executor: 'apps/api/src/moderation/moderation-delete-intent.service.ts',
  view: 'apps/api/src/moderation/reports/report-view.service.ts',
  submission: 'apps/api/src/moderation/reports/report-submission.service.ts',
};

function replaceChecked(source, anchor, replacement, all = false) {
  const count =
    typeof anchor === 'string'
      ? source.split(anchor).length - 1
      : [...source.matchAll(new RegExp(anchor.source, `${anchor.flags.replaceAll('g', '')}g`))]
          .length;
  assert.ok(count > 0, `mutation anchor must exist: ${anchor}`);
  if (!all) assert.equal(count, 1, `mutation anchor must be unique: ${anchor}`);
  const changed = all
    ? source.replaceAll(anchor, replacement)
    : source.replace(anchor, replacement);
  assert.notEqual(changed, source, `mutation must change source: ${anchor}`);
  return changed;
}

function mutateMethod(source, marker, mutate) {
  assert.equal(source.split(marker).length - 1, 1, `method must be unique: ${marker}`);
  const start = source.indexOf(marker);
  const end = source.indexOf('\n  private ', start + marker.length);
  assert.ok(end > start, `method must have a following boundary: ${marker}`);
  const original = source.slice(start, end);
  const changed = mutate(original);
  assert.notEqual(changed, original, `method mutation must change bytes: ${marker}`);
  return source.slice(0, start) + changed + source.slice(end);
}

test('both rollback paths require guarded participant report execution', async (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'maxim-report-guard-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const file of ['vps-release-rollback.sh', 'vps-runtime-rollback.sh']) {
    assert.match(
      readFileSync(resolve(root, 'infra/scripts', file), 'utf8'),
      /maxim_topology_require_participant_report_guard/u,
    );
  }
  const current = Object.fromEntries(
    Object.entries(paths).map(([key, path]) => [key, readFileSync(resolve(root, path), 'utf8')]),
  );
  const boundaryMarker = '  private async runDeletePreDispatchGuards(';
  const composerMarker = '  private async authorizeGuardedUserDeleteReasons(';
  const standalonePreparation = `reportPreparation = await this.reportDeleteGuard.prepareForDispatch({
              intentId: intent.id,
              chatId: intent.chatId,
              messageId: intent.messageId,
              subjectUserId: intent.subjectUserId,
              botId,
              trafficClass: intent.reportHistoryOnly ? 'background' : 'critical',
              isIndependentReasonExecutable: (reasons) =>
                this.hasExecutableIndependentReportReason(intent.chatId, reasons),
            });`;
  const unavailable = `if (!this.reportDeleteGuard && hasReportReason)
            throw new Error('Participant report delete guard unavailable');`;
  const standaloneFinalizer = 'const report = await finalizeDeleteAuthority(reportPreparation);';
  const standaloneAbsence = `if (report === 'absent')
                throw new ModerationDeleteGuardedMessageAbsentError('guarded_report_absence');`;
  const standaloneResult = `${standaloneFinalizer}\n              ${standaloneAbsence}`;
  const callbackStart = `async () => {
              await beforeFinalAuthority?.();
              imageTextStopListGuard = await finalizeDeleteAuthority(imageTextPreparation);
              ${standaloneFinalizer}`;
  const reportBranch = `if (reasons.some((r) => REPORT_GUARDED_RULES.has(r.ruleCode))) {
      if (!this.reportDeleteGuard) throw new Error('Participant report delete guard unavailable');
      const reportParams = {
        ...params,
        trafficClass: intent.reportHistoryOnly ? ('background' as const) : ('critical' as const),
        isIndependentReasonExecutable: () => false,
      };
      await prepare(() =>
        deferred
          ? this.reportDeleteGuard!.prepareForDispatch(reportParams)
          : this.reportDeleteGuard!.assertIntentStillActionable(reportParams),
      );
    }`;
  const sharedAbsence = `if (result === 'absent')
            throw new ModerationDeleteGuardedMessageAbsentError('guarded_current_message_absence');`;
  const invalidAuthority = `if (result !== 'allowed' && (typeof result !== 'object' || result === null))
            throw new Error('Required moderation reason guard did not supply authority');`;
  const mutation = (name, key, anchor, replacement, all = false) => [
    name,
    { [key]: replaceChecked(current[key], anchor, replacement, all) },
    1,
  ];
  const methodMutation = (name, marker, anchor, replacement) => [
    name,
    {
      executor: mutateMethod(current.executor, marker, (method) =>
        replaceChecked(method, anchor, replacement),
      ),
    },
    1,
  ];
  const standaloneMutation = (name, anchor, replacement) =>
    methodMutation(name, boundaryMarker, anchor, replacement);
  const composerMutation = (name, anchor, replacement) =>
    methodMutation(name, composerMarker, anchor, replacement);
  const reportBranchMutation = (name, anchor, replacement) =>
    composerMutation(name, reportBranch, replaceChecked(reportBranch, anchor, replacement));
  // FLAG: Bounded direct-v3 legacy evidence remains independent of retained Git history.
  const legacyExecutor = `class LegacyReportExecutor {
  private async runDeletePreDispatchGuards(intent: IntentRow, botId: string, options?: Options) {
    if (!this.reportDeleteGuard) throw new Error('Participant report delete guard unavailable');
    const report = await this.reportDeleteGuard.assertIntentStillActionable({
      intentId: intent.id,
      chatId: intent.chatId,
      messageId: intent.messageId,
      subjectUserId: intent.subjectUserId,
      botId,
      isIndependentReasonExecutable: (reasons) =>
        this.hasExecutableIndependentReportReason(intent.chatId, reasons),
    });
    if (report === 'absent')
      throw new ModerationDeleteGuardedMessageAbsentError('guarded_report_absence');
    await options?.beforeDeleteMutation?.();
  }
  private hasExecutableIndependentReportReason(chatId: string, reasons: Reason[]) {
    return reasons.some((reason) => this.getRolloutForInput({
      chatId, event: { metadata: reason.metadata },
    }) === 'execute');
  }
  private isReportReason(intent: IntentRow) {
    if (intent.reportDeleteReason === true) return true;
    return false;
  }
  private async classifiers() {
    return this.prisma.$queryRaw\`SELECT true AS "reportDeleteReason", true AS "reportCounterCleanupReason"\`;
  }
}
`;
  const cases = [
    ['current', {}, 0],
    ['legacy-direct-v3', { executor: legacyExecutor }, 0],
    ...[
      ['duplicate-dispatch-boundary', boundaryMarker],
      ['duplicate-authority-composer', composerMarker],
    ].map(([name, marker]) => [
      name,
      { executor: mutateMethod(current.executor, marker, (method) => `${method}\n${method}`) },
      1,
    ]),
    ['missing', {}, 1],
    mutation('legacy', 'guard', 'BINDING_VERSION = 3', 'BINDING_VERSION = 2'),
    mutation(
      'generic-dependent',
      'executor',
      'if (intent.reportDeleteReason === true) return true;',
      'if (false) return true;',
    ),
    mutation(
      'no-ownership',
      'guard',
      'counterMessageId: params.messageId',
      'counterMessageId: "lost"',
    ),
    mutation(
      'first-only',
      'guard',
      'for (const reason of reportReasons)',
      'for (const reason of reportReasons.slice(0, 1))',
    ),
    mutation(
      'dormant-independent',
      'guard',
      'params.isIndependentReasonExecutable?.(independentReasons)',
      'true',
    ),
    methodMutation(
      'dormant-independent-helper',
      '  private hasExecutableIndependentReportReason(',
      'this.getRolloutForInput({',
      'this.dormantAuthority({',
    ),
    mutation(
      'no-state-check',
      'guard',
      'this.state.assertCurrent(',
      'this.state.dormantCurrent(',
      true,
    ),
    mutation(
      'no-policy-check',
      'guard',
      'this.state.assertPolicy(',
      'this.state.dormantPolicy(',
      true,
    ),
    mutation('no-case-check', 'guard', 'this.state.assertCase(', 'this.state.dormantCase(', true),
    mutation(
      'guard-wrapper-drops-finalization',
      'guard',
      'return finalizeDeleteAuthority(await this.prepareForDispatch(params));',
      'return this.prepareForDispatch(params);',
    ),
    standaloneMutation(
      'standalone-missing-preparation',
      standalonePreparation,
      replaceChecked(
        standalonePreparation,
        'reportPreparation = await',
        'reportPreparation = undefined; await',
      ),
    ),
    standaloneMutation(
      'standalone-unawaited-preparation',
      standalonePreparation,
      replaceChecked(
        standalonePreparation,
        '= await this.reportDeleteGuard',
        '= this.reportDeleteGuard',
      ),
    ),
    ...[
      ['intent', 'intentId: intent.id', 'intentId: intent.messageId'],
      ['chat', 'chatId: intent.chatId', 'chatId: intent.messageId'],
      ['message', 'messageId: intent.messageId', 'messageId: intent.chatId'],
      ['subject', 'subjectUserId: intent.subjectUserId', 'subjectUserId: null'],
      ['bot', '              botId,', '              botId: intent.chatId,'],
    ].map(([name, anchor, replacement]) =>
      standaloneMutation(
        `standalone-wrong-${name}`,
        standalonePreparation,
        replaceChecked(standalonePreparation, anchor, replacement),
      ),
    ),
    standaloneMutation(
      'standalone-independent-always-true',
      standalonePreparation,
      replaceChecked(
        standalonePreparation,
        '(reasons) =>\n                this.hasExecutableIndependentReportReason(intent.chatId, reasons)',
        '() => true',
      ),
    ),
    standaloneMutation('standalone-unavailable-guard-ignored', unavailable, ''),
    standaloneMutation(
      'standalone-cleanup-predicate-inverted',
      'if (this.reportDeleteGuard && !hasReportReason)',
      'if (this.reportDeleteGuard && hasReportReason)',
    ),
    standaloneMutation(
      'standalone-missing-finalizer',
      standaloneFinalizer,
      'const report = undefined;',
    ),
    [
      'standalone-finalization-outside-callback',
      {
        executor: mutateMethod(current.executor, boundaryMarker, (boundary) =>
          replaceChecked(
            replaceChecked(boundary, standaloneResult, ''),
            'const proof = await this.authorizeGuardedUserDeleteReasons(',
            `${standaloneResult}\n        const proof = await this.authorizeGuardedUserDeleteReasons(`,
          ),
        ),
      },
      1,
    ],
    standaloneMutation(
      'standalone-duplicate-finalizer',
      standaloneFinalizer,
      `${standaloneFinalizer}\n            await finalizeDeleteAuthority(reportPreparation);`,
    ),
    standaloneMutation(
      'standalone-inline-comment-decoy',
      standaloneResult,
      `void 0; // ${`${callbackStart}\n            ${standaloneAbsence}`.replaceAll('\n', ' ')}`,
    ),
    standaloneMutation(
      'standalone-unawaited-finalizer',
      standaloneFinalizer,
      'const report = finalizeDeleteAuthority(reportPreparation);',
    ),
    standaloneMutation(
      'standalone-wrong-capsule',
      standaloneFinalizer,
      'const report = await finalizeDeleteAuthority(imageTextPreparation);',
    ),
    standaloneMutation(
      'standalone-discarded-result',
      standaloneFinalizer,
      'await finalizeDeleteAuthority(reportPreparation); const report = undefined;',
    ),
    standaloneMutation('standalone-missing-absence', standaloneAbsence, ''),
    standaloneMutation(
      'standalone-wrong-absence-error',
      standaloneAbsence,
      replaceChecked(standaloneAbsence, 'ModerationDeleteGuardedMessageAbsentError', 'Error'),
    ),
    standaloneMutation(
      'standalone-unawaited-composer',
      'const proof = await this.authorizeGuardedUserDeleteReasons(',
      'const proof = this.authorizeGuardedUserDeleteReasons(',
    ),
    standaloneMutation(
      'standalone-late-checkpoint',
      callbackStart,
      replaceChecked(callbackStart, 'await beforeFinalAuthority?.();\n              ', '') +
        '\n            await beforeFinalAuthority?.();',
    ),
    standaloneMutation(
      'standalone-unawaited-checkpoint',
      callbackStart,
      replaceChecked(callbackStart, 'await beforeFinalAuthority?.();', 'beforeFinalAuthority?.();'),
    ),
    reportBranchMutation(
      'composer-no-report-predicate',
      'if (reasons.some((r) => REPORT_GUARDED_RULES.has(r.ruleCode)))',
      'if (false)',
    ),
    reportBranchMutation(
      'composer-unavailable-guard-ignored',
      "if (!this.reportDeleteGuard) throw new Error('Participant report delete guard unavailable');",
      '',
    ),
    reportBranchMutation(
      'composer-independent-always-true',
      'isIndependentReasonExecutable: () => false',
      'isIndependentReasonExecutable: () => true',
    ),
    reportBranchMutation('composer-unawaited-preparation', 'await prepare(() =>', 'prepare(() =>'),
    reportBranchMutation(
      'composer-wrong-report-params',
      '.prepareForDispatch(reportParams)',
      '.prepareForDispatch(params)',
    ),
    composerMutation(
      'composer-preparation-not-collected',
      'candidates.push({ preparation, keys, tag, fixedDeadlines });',
      'candidates.push({ preparation: undefined, keys, tag, fixedDeadlines });',
    ),
    composerMutation(
      'composer-preparation-result-discarded',
      'const preparation = await run();',
      'await run(); const preparation = undefined;',
    ),
    composerMutation(
      'composer-missing-preparation-absence',
      `if (preparation === 'absent')\n          throw new ModerationDeleteGuardedMessageAbsentError('guarded_current_message_absence');`,
      '',
    ),
    composerMutation('composer-missing-checkpoint', 'await beforeFinalAuthority?.();', ''),
    composerMutation(
      'composer-unawaited-checkpoint',
      'await beforeFinalAuthority?.();',
      'beforeFinalAuthority?.();',
    ),
    composerMutation(
      'composer-duplicate-checkpoint',
      'await beforeFinalAuthority?.();',
      'await beforeFinalAuthority?.(); await beforeFinalAuthority?.();',
    ),
    [
      'composer-late-checkpoint',
      {
        executor: mutateMethod(current.executor, composerMarker, (method) =>
          replaceChecked(
            replaceChecked(method, 'await beforeFinalAuthority?.();', ''),
            'const result = await finalizeDeleteAuthority(candidate.preparation);',
            'const result = await finalizeDeleteAuthority(candidate.preparation); await beforeFinalAuthority?.();',
          ),
        ),
      },
      1,
    ],
    composerMutation(
      'composer-missing-finalizer',
      'const result = await finalizeDeleteAuthority(candidate.preparation);',
      "const result = 'allowed';",
    ),
    composerMutation(
      'composer-unawaited-finalizer',
      'const result = await finalizeDeleteAuthority(candidate.preparation);',
      'const result = finalizeDeleteAuthority(candidate.preparation);',
    ),
    composerMutation(
      'composer-wrong-capsule',
      'const result = await finalizeDeleteAuthority(candidate.preparation);',
      'const result = await finalizeDeleteAuthority(reportPreparation);',
    ),
    composerMutation('composer-missing-final-absence', sharedAbsence, ''),
    composerMutation('composer-invalid-authority-accepted', invalidAuthority, ''),
    composerMutation(
      'composer-does-not-finalize-collected-candidates',
      'return finalizeCandidates(candidates, true);',
      'return finalizeCandidates([], true);',
    ),
    [
      'composer-comment-decoy',
      {
        executor: `${mutateMethod(current.executor, composerMarker, (method) =>
          replaceChecked(
            method,
            'const result = await finalizeDeleteAuthority(candidate.preparation);',
            "const result = 'allowed';",
          ),
        )}\n// const result = await finalizeDeleteAuthority(candidate.preparation);\n`,
      },
      1,
    ],
    mutation(
      'archive-unversioned',
      'view',
      'ARCHIVE_READER_VERSION = 1',
      'ARCHIVE_READER_VERSION = 0',
    ),
    ['archive-missing-view', {}, 1],
    mutation('archive-reopens', 'submission', 'if (current?.detailsArchivedAt)', 'if (false)'),
    mutation(
      'archive-reveals-reporters',
      'view',
      'const reporters = report.detailsArchivedAt',
      'const reporters = false',
    ),
    mutation(
      'archive-drops-cases',
      'view',
      'return reports.map((report) => {',
      'return live.map((report) => {',
    ),
    ...['Votes', 'Candidates', 'Deleted', 'Absent', 'Failed'].map((field) =>
      mutation(`archive-no-${field}`, 'view', `retained${field}`, 'missingRetainedTotal', true),
    ),
  ];
  for (const [variant, overrides, expected] of cases) {
    await t.test(variant, () => {
      const fixturePaths = {};
      for (const [key, source] of Object.entries({ ...current, ...overrides })) {
        fixturePaths[key] = resolve(directory, `${key}.ts`);
        writeFileSync(fixturePaths[key], source);
      }
      const diagnosticsPath = resolve(directory, 'parser.stderr');
      const statusPath = resolve(directory, 'parser.status');
      writeFileSync(diagnosticsPath, '', { mode: 0o600 });
      writeFileSync(statusPath, '', { mode: 0o600 });
      const result = spawnSync(
        'bash',
        [
          '-c',
          `
source "$MAXIM_TEST_ROOT/infra/scripts/lib/deploy-topology.sh"
node() {
  local status
  # FLAG: Reproduce short pipe reads before a larger write. UTF-8 fast-path
  # stdin reads can corrupt memory on Node 24; a crash must never pass a guard.
  if "$MAXIM_TEST_NODE" --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { setTimeout } from "node:timers/promises";
    const input = readFileSync(0);
    let offset = 0;
    for (; offset < Math.min(96000, input.length); offset += 4000) {
      const chunk = input.subarray(offset, Math.min(offset + 4000, input.length));
      await new Promise((resolve) => process.stdout.write(chunk, resolve));
      await setTimeout(5);
    }
    process.stdout.end(input.subarray(offset));
  ' | "$MAXIM_TEST_NODE" "$@" 2>>"$MAXIM_TEST_NODE_STDERR"; then
    status=0
  else
    status=$?
  fi
  printf '%s\\n' "$status" >>"$MAXIM_TEST_NODE_STATUS"
  return "$status"
}
git() {
  if [[ "$MAXIM_TEST_VARIANT" == missing || "$1" != show ]]; then return 1; fi
  local source_path="\${2#*:}"
  case "$source_path" in
    */report-delete-guard.service.ts) cat "$GUARD_FIXTURE" ;;
    */moderation-delete-intent.service.ts) cat "$EXECUTOR_FIXTURE" ;;
    */report-view.service.ts)
      if [[ "$MAXIM_TEST_VARIANT" == archive-missing-view ]]; then return 1; fi
      cat "$VIEW_FIXTURE" ;;
    */report-submission.service.ts) cat "$SUBMISSION_FIXTURE" ;;
    *) return 1 ;;
  esac
}
maxim_topology_require_participant_report_guard target
`,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            // FLAG: Bound background pools while retaining real parser verdicts.
            NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --v8-pool-size=1`.trim(),
            UV_THREADPOOL_SIZE: '1',
            MAXIM_TEST_NODE: process.execPath,
            MAXIM_TEST_NODE_STDERR: diagnosticsPath,
            MAXIM_TEST_NODE_STATUS: statusPath,
            MAXIM_TEST_ROOT: root,
            MAXIM_TEST_VARIANT: variant,
            GUARD_FIXTURE: fixturePaths.guard,
            EXECUTOR_FIXTURE: fixturePaths.executor,
            VIEW_FIXTURE: fixturePaths.view,
            SUBMISSION_FIXTURE: fixturePaths.submission,
            PARTICIPANT_REPORTS_DETAIL_RETENTION_ENABLED: 'false',
          },
          encoding: 'utf8',
        },
      );
      // FLAG: A parser crash is never evidence that an incompatible target was rejected.
      const statuses = readFileSync(statusPath, 'utf8').trim().split('\n').filter(Boolean);
      const diagnostics = `${variant}\nparser statuses: ${statuses.join(', ')}\n${result.stderr}\n${readFileSync(diagnosticsPath, 'utf8')}`;
      if (variant !== 'missing') assert.ok(statuses.length > 0, diagnostics);
      assert.ok(
        statuses.every((status) => status === '0' || status === '1'),
        diagnostics,
      );
      assert.equal(result.error, undefined, diagnostics);
      assert.equal(result.signal, null, diagnostics);
      assert.equal(result.status, expected, diagnostics);
      if (variant.startsWith('archive-')) assert.match(result.stderr, /archive/u, diagnostics);
    });
  }
});
