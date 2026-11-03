import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

const source = readFileSync(
  new URL('./smoke-outcome-cohort-online-client-ci.sh', import.meta.url),
  'utf8',
);
const start = source.indexOf('inspect_ci_object() {');
const end = source.indexOf('trap cleanup EXIT', start);
assert(start > 0 && end > start);
const cleanup = source.slice(start, end);
const reserve = Number(source.match(/timeout --kill-after=(\d+)s 300s/u)?.[1]);

function runCleanup(mode, exitCode = 0, terminate = false) {
  const directory = mkdtempSync(resolve(tmpdir(), 'maxim-outcome-ci-cleanup-'));
  const fixture = resolve(directory, 'fixture');
  const log = resolve(directory, 'calls');
  mkdirSync(fixture);
  writeFileSync(log, '');
  writeFileSync(
    resolve(directory, 'docker'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$MAXIM_CLEANUP_LOG"
object=''
for argument in "$@"; do object="$argument"; done
case "$1:$2" in
  container:inspect)
    [[ "$MAXIM_CLEANUP_MODE" == present ]] || exit 1
    printf '%064d\\n' 1 ;;
  container:ls)
    [[ "$MAXIM_CLEANUP_MODE" != failed ]] || exit 1
    [[ "$MAXIM_CLEANUP_MODE" != ambiguous ]] || printf 'still-present\\n' ;;
  network:inspect)
    if [[ "$MAXIM_CLEANUP_MODE" == hang && "$object" == infra_default ]]; then
      trap '' TERM
      while :; do sleep 1; done
    fi
    [[ "$MAXIM_CLEANUP_MODE" == present || "$MAXIM_CLEANUP_MODE" == foreign ]] || exit 1
    if [[ "$MAXIM_CLEANUP_MODE" == foreign && "$object" == infra_default ]]; then
      printf 'foreign-owner\\n'
    else
      printf 'owned-fixture\\n'
    fi ;;
  network:ls)
    [[ "$MAXIM_CLEANUP_MODE" != failed && "$MAXIM_CLEANUP_MODE" != hang ]] || exit 1
    [[ "$MAXIM_CLEANUP_MODE" != ambiguous ]] || printf 'still-present\\n' ;;
  ps:*) [[ "$MAXIM_CLEANUP_MODE" != present ]] || printf '%064d\\n' 2 ;;
  rm:*|network:rm) exit 0 ;;
  *) exit 98 ;;
esac
`,
    { mode: 0o755 },
  );
  const harness = `set -euo pipefail
fixture_dir="$1"
owner=owned-fixture
project=multibot_ci_fixture
good_tag=maxim-online-bootstrap
cancel_tag=maxim-online-delete
resolver_tag=maxim-online-recipient
routing_bootstrap_tag=maxim-online-routing-bootstrap
routing_tag=maxim-online-routing
attempt_owned=1
${cleanup}
trap cleanup EXIT
trap 'exit 143' TERM
${terminate ? 'sleep 30' : `exit ${exitCode}`}
`;
  try {
    const args = ['-c', harness, 'outcome-ci-cleanup-test', fixture];
    const result = spawnSync(
      terminate ? 'timeout' : 'bash',
      terminate ? [`--kill-after=${reserve}s`, '0.2s', 'bash', ...args] : args,
      {
        encoding: 'utf8',
        timeout: 8000,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          MAXIM_CLEANUP_MODE: mode,
          MAXIM_CLEANUP_LOG: log,
        },
      },
    );
    return { ...result, calls: readFileSync(log, 'utf8'), fixtureRemoved: !existsSync(fixture) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('CI cleanup reserve covers every hard-bounded cleanup command', () => {
  assert(reserve > 17 * 3, 'reserve must exceed seventeen 3-second cleanup commands');
  assert.doesNotMatch(cleanup, /(?<!3s )docker /u);
});

test('CI cleanup distinguishes confirmed absence from failed or ambiguous inspection', () => {
  for (const mode of ['present', 'absent', 'failed', 'ambiguous', 'foreign']) {
    const result = runCleanup(mode);
    assert.equal(result.status, ['present', 'absent'].includes(mode) ? 0 : 1, result.stderr);
    assert.equal(result.fixtureRemoved, true);
    assert.match(result.stderr, /CLEANUP_PENDING/u);
    assert.match(
      result.stderr,
      ['present', 'absent'].includes(mode) ? /CLEANUP_CONFIRMED/u : /CLEANUP_UNCONFIRMED/u,
    );
    if (mode === 'present') {
      for (const tag of ['bootstrap', 'delete', 'recipient', 'routing-bootstrap', 'routing']) {
        assert.match(result.calls, new RegExp(`rm -f maxim-online-${tag}`, 'u'));
      }
      assert.match(result.calls, /network rm infra_default/u);
    } else {
      assert.doesNotMatch(result.calls, /rm -f|network rm infra_default/u);
    }
  }
});

test('CI cleanup preserves original failures and hard-kills an unresponsive inspection', () => {
  const result = runCleanup('hang', 7);
  assert.equal(result.status, 7, result.stderr);
  assert.equal(result.fixtureRemoved, true);
  assert.match(result.stderr, /CLEANUP_UNCONFIRMED/u);
  assert.match(result.calls, /network ls --filter name=\^infra_default\$/u);
});

test('CI work timeout reaches cleanup before the reserved hard deadline', () => {
  const result = runCleanup('present', 0, true);
  assert.equal(result.status, 124, result.stderr);
  assert.equal(result.fixtureRemoved, true);
  assert.match(result.stderr, /CLEANUP_CONFIRMED/u);
  assert.match(result.calls, /network rm infra_default/u);
});
