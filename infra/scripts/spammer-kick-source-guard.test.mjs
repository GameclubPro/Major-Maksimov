import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { spammerKickSourceMode } from './assert-spammer-kick-source.mjs';

const sources = {
  'spammer-kick-followup.ts': [
    'export async function executeSpammerKickFollowup(row) {',
    "getExplicitActionJobId('KICK_MEMBER', actionKey);",
    "if (row.moderationDeleteVerified && row.phase === 'KICK_STARTED') return 'UNKNOWN';",
    '}',
    'export function spammerMessageKickKey() {}',
  ].join('\n'),
  'moderation-rule-followup.service.ts': [
    "import { executeSpammerKickFollowup, isSpammerKickRule } from './spammer-kick-followup';",
    'if (isSpammerKickRule(row.ruleCode)) await executor.executeSpammerKickFollowup(row, leaseToken, receiptOnly);',
  ].join('\n'),
  'spammer-kick-followup-writer.ts': [
    'export const SPAMMER_KICK_FOLLOWUP_WRITES = true;',
    'return ensureIntentWithRuleFollowup(input);',
  ].join('\n'),
  'moderation.service.legacy.ts': [
    "import { executeSpammerKickFollowup } from './spammer-kick-followup';",
    'return executeSpammerKickFollowup(row, leaseToken, receiptOnly, deps);',
    "import { persistSpammerKickFollowup } from './spammer-kick-followup-writer';",
    'await persistSpammerKickFollowup(input);',
  ].join('\n'),
};
const mode = (files) => spammerKickSourceMode((path) => files[path.split('/').at(-1)] ?? null);

test('source modes distinguish prior releases, compatible readers and active writers', () => {
  assert.equal(mode({}), 'legacy');
  assert.equal(mode({ ...sources, 'spammer-kick-followup-writer.ts': null }), 'reader');
  assert.equal(mode(sources), 'writer');
  assert.throws(
    () =>
      mode({
        ...sources,
        'moderation-rule-followup.service.ts':
          '/* ' + sources['moderation-rule-followup.service.ts'] + ' */',
      }),
    /cannot continue/u,
  );
  assert.throws(
    () =>
      mode({
        ...sources,
        'moderation.service.legacy.ts': sources['moderation.service.legacy.ts'].replace(
          'await persistSpammerKickFollowup(input);',
          '',
        ),
      }),
    /incomplete.*writer/u,
  );
});

test('first writer needs a running reader and its immutable rollback image', () => {
  const controller = readFileSync(new URL('./vps-pull-build-up.sh', import.meta.url), 'utf8');
  const guard = controller.match(/^verify_spammer_kick_writer_rollout\(\) \{[\s\S]*?^\}/mu)?.[0];
  assert.ok(guard, 'Deploy writer guard must exist');
  assert.match(
    controller,
    /verify_spammer_kick_writer_rollout "\$\(git rev-parse --verify HEAD\)" \|\| exit 1/u,
  );
  const driveGuard = (target, baseline, retained, running) =>
    spawnSync(
      'bash',
      [
        '-c',
        [
          guard,
          'node() { case "$2" in selected) echo "$CANDIDATE" ;; accepted) echo "$ACCEPTED" ;; *) return 1 ;; esac; }',
          'docker() { printf "%s\\n" "$RETAINED"; }',
          'component_manifest_matches_runtime() { [[ "$RUNNING" == yes ]]; }',
          'release_field() { case "$2" in sourceSha) echo accepted ;; imageRef) echo maxim-api:accepted ;; imageId) echo "' +
            digest +
            '" ;; esac; }',
          'verify_spammer_kick_writer_rollout selected',
        ].join('\n'),
      ],
      {
        env: {
          ...process.env,
          CANDIDATE: target,
          ACCEPTED: baseline,
          RETAINED: retained,
          RUNNING: running,
          RECOVERY_BASE_MANIFEST: '',
        },
        encoding: 'utf8',
      },
    ).status;
  const digest = 'sha256:' + 'a'.repeat(64);
  assert.equal(driveGuard('reader', 'legacy', '', 'no'), 0);
  assert.equal(driveGuard('writer', 'legacy', digest, 'yes'), 1);
  assert.equal(driveGuard('writer', 'reader', '', 'yes'), 1);
  assert.equal(driveGuard('writer', 'reader', digest, 'no'), 1);
  assert.equal(driveGuard('writer', 'reader', digest, 'yes'), 0);
});

test('both API rollback entrypoints preserve the deferred removal reader', () => {
  const read = (name) => readFileSync(new URL('./' + name, import.meta.url), 'utf8');
  const immutable = read('vps-release-rollback.sh');
  const runtime = read('vps-runtime-rollback.sh');
  const connector = read('vps-connect.sh');
  const releaseCheck = immutable.indexOf(
    'maxim_topology_require_spammer_kick_reader "$API_SOURCE_SHA"',
  );
  assert.ok(
    releaseCheck > 0 && releaseCheck < immutable.indexOf('begin_release_runtime_transition', releaseCheck),
  );
  const refCheck = runtime.indexOf('maxim_topology_require_spammer_kick_reader "$TARGET_FULL_SHA"');
  assert.ok(refCheck > 0 && refCheck < runtime.indexOf('git switch --detach "$TARGET_FULL_SHA"'));
  assert.match(runtime, /Ref-based rollback would remove the spammer removal reader floor/u);
  assert.match(
    connector,
    /rollback_with_spammer_kick_reader \.\/infra\/scripts\/vps-runtime-rollback\.sh/u,
  );
  assert.match(
    connector,
    /if release_rollback_includes_api "\$@"; then\s+rollback_with_spammer_kick_reader \.\/infra\/scripts\/vps-release-rollback\.sh/u,
  );
  assert.match(connector, /else\s+rollback_release "\$@"/u);
});
