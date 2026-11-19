import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { assertManagedGiveawaySource } from './assert-managed-giveaway-source.mjs';

const root = resolve(import.meta.dirname, '../..');
const receipt = '20261119043001_add_managed_giveaway_results_sync';
const service = 'apps/api/src/admin/managed-giveaway.service.ts';
const sync = 'apps/api/src/admin/managed-giveaway-results-sync.ts';
const history = 'apps/api/src/admin/managed-giveaway-read-model.ts';
const read = (path) => readFileSync(join(root, path), 'utf8');

test('applied giveaway state rejects source without the archive or results reader', () => {
  const sha = 'a'.repeat(40);
  assert.doesNotThrow(() => assertManagedGiveawaySource(sha, read));
  for (const [path, clause] of [
    [service, 'await this.lockGiveawayForWinnerMutation(tx, giveawayId)'],
    [service, 'data: { archivedAt: new Date() }'],
    [service, "await this.syncGiveawayResults(giveawayId, 'runner')"],
    [sync, 'if (!(await publish(assertCurrent))) return false;'],
    [history, 'WHERE archived_at IS NULL'],
  ]) {
    const changed = read(path).replaceAll(clause, `/* ${clause} */ missingReader`);
    assert.notEqual(changed, read(path));
    assert.throws(
      () =>
        assertManagedGiveawaySource(sha, (source) => (source === path ? changed : read(source))),
      /lacks giveaway archive or results-sync handling/u,
    );
  }
});

test('ref and immutable rollback use the applied receipt and exact API source before mutation', (t) => {
  const repository = mkdtempSync(join(tmpdir(), 'giveaway-rollback-'));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  const write = (path, contents) => {
    mkdirSync(dirname(join(repository, path)), { recursive: true });
    writeFileSync(join(repository, path), contents);
  };
  const git = (...args) => {
    const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  const checker = 'infra/scripts/assert-managed-giveaway-source.mjs';
  write(checker, read(checker));
  const commit = () => {
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'state reader',
    );
    return git('rev-parse', 'HEAD');
  };
  const old = commit();
  for (const file of [service, history, sync]) write(file, read(file));
  const current = commit();
  const run = (sha, receipts) =>
    spawnSync(
      'bash',
      [
        '-c',
        'source "$1"; maxim_topology_require_giveaway_state_reader "$2"',
        'fixture',
        join(root, 'infra/scripts/lib/deploy-topology.sh'),
        sha,
      ],
      { cwd: repository, encoding: 'utf8', input: receipts },
    );
  assert.equal(run(old, '20261119043000_add_managed_giveaway_draft_revision\n').status, 0);
  assert.notEqual(run(old, `${receipt}\n`).status, 0);
  const accepted = run(current, `${receipt}\n`);
  assert.equal(accepted.status, 0, accepted.stderr);

  const runtime = read('infra/scripts/vps-runtime-rollback.sh');
  const immutable = read('infra/scripts/vps-release-rollback.sh');
  const refCall =
    'maxim_topology_require_giveaway_state_reader "$TARGET_FULL_SHA" <<<"$giveaway_migration_receipts"';
  assert.ok(
    runtime.indexOf(refCall) >
      runtime.indexOf('if ! giveaway_migration_receipts="$(read_applied_prisma_migrations)"'),
  );
  assert.ok(runtime.indexOf(refCall) < runtime.indexOf('\ngit switch --detach "$TARGET_FULL_SHA"'));
  const imageCall =
    'maxim_topology_require_giveaway_state_reader "$API_SOURCE_SHA" <"$APPLIED_MIGRATIONS_FILE"';
  const selection = immutable.lastIndexOf(
    'if [[ "$SELECT_API" -eq 1 ]]; then',
    immutable.indexOf(imageCall),
  );
  assert.ok(selection >= 0);
  assert.ok(
    immutable.indexOf('SELECT migration_name FROM _prisma_migrations', selection) <
      immutable.indexOf(imageCall),
  );
  assert.ok(
    immutable.indexOf(imageCall) < immutable.indexOf('\nbegin_release_runtime_transition\n'),
  );
  assert.match(immutable, /API_SOURCE_SHA="\$\{COMPONENT_SOURCE_SHA\[api-shared\]\}"/u);
});

test('giveaway writer activation verifies the installed reader, rollback image and stopped mutation owners', (t) => {
  const repository = mkdtempSync(join(tmpdir(), 'giveaway-activation-'));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  const write = (path, contents) => {
    mkdirSync(dirname(join(repository, path)), { recursive: true });
    writeFileSync(join(repository, path), contents);
  };
  const git = (...args) => {
    const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const commit = () => {
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@local',
      'commit',
      '--allow-empty',
      '-qm',
      'fixture',
    );
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  const helper = 'infra/scripts/assert-managed-giveaway-source.mjs';
  write(helper, read(helper));
  const legacy = commit();
  for (const file of [service, history, sync]) write(file, read(file));
  const syncSource = read(sync);
  const mode = /^export const MANAGED_GIVEAWAY_RESULTS_SYNC_ACTIVATED = (true|false);$/mu;
  assert.match(syncSource, mode);
  write(
    sync,
    syncSource.replace(mode, 'export const MANAGED_GIVEAWAY_RESULTS_SYNC_ACTIVATED = false;'),
  );
  const reader = commit();
  write(
    sync,
    syncSource.replace(mode, 'export const MANAGED_GIVEAWAY_RESULTS_SYNC_ACTIVATED = true;'),
  );
  const writer = commit();
  write(
    sync,
    syncSource.replace(mode, '// export const MANAGED_GIVEAWAY_RESULTS_SYNC_ACTIVATED = false;'),
  );
  const invalid = commit();
  const deploy = read('infra/scripts/vps-pull-build-up.sh');
  const section = deploy.slice(
    deploy.indexOf('verify_giveaway_writer_rollout() {'),
    deploy.indexOf('impact_plan_selects_component() {'),
  );
  const check = (target, current, flags = {}) =>
    spawnSync(
      'bash',
      [
        '-c',
        section +
          `
    set -eu
    image_id=sha256:$(printf 'a%.0s' {1..64})
    release_field() { case "$2" in sourceSha) echo "$CURRENT";; imageRef) echo "maxim-api:$CURRENT";; imageId) printf 'sha256:%s\\n' "$(printf 'a%.0s' {1..64})";; esac; }
    docker() { case "$1" in image) test "$RETAINED" = yes && printf 'sha256:%s\\n' "$(printf 'a%.0s' {1..64})";; compose) echo "stop $*";; esac; }
    component_manifest_matches_runtime() { test "$MATCHES" = yes; }
    maxim_webhook_rollout_verify_services_stopped() { echo "verify $*"; test "$STOPPED" = yes; }
    COMPOSE_FILES=(-f fixture.yml)
    MAXIM_WEBHOOK_ROLLOUT_STOP_TIMEOUT_SEC=60
    verify_giveaway_writer_rollout "$TARGET_SHA" || exit 1
    quiesce_giveaway_writer_transition || exit 1
  `,
      ],
      {
        cwd: repository,
        encoding: 'utf8',
        env: {
          ...process.env,
          TARGET_SHA: target,
          CURRENT: current,
          RETAINED: 'yes',
          MATCHES: 'yes',
          STOPPED: 'yes',
          RECOVERY_BASE_MANIFEST: '',
          ...flags,
        },
      },
    );
  assert.equal(check(reader, legacy, { RETAINED: 'no' }).status, 0);
  assert.notEqual(check(writer, legacy).status, 0);
  assert.notEqual(check(invalid, reader).status, 0);
  assert.notEqual(check(writer, reader, { RETAINED: 'no' }).status, 0);
  assert.notEqual(check(writer, reader, { MATCHES: 'no' }).status, 0);
  assert.notEqual(check(writer, reader, { STOPPED: 'no' }).status, 0);
  const first = check(writer, reader);
  assert.equal(first.status, 0, first.stderr);
  assert.match(
    first.stdout,
    /stop compose -f fixture.yml stop -t 60 api-action api-admin\nverify COMPOSE_FILES api-action api-admin/u,
  );
  const repeated = check(writer, writer, { MATCHES: 'no', RETAINED: 'no' });
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.stdout.trim(), '');
  const recovery = check(writer, reader, {
    MATCHES: 'no',
    RECOVERY_BASE_MANIFEST: '/reviewed-base',
  });
  assert.equal(recovery.status, 0, recovery.stderr);
  assert.match(recovery.stdout, /verify COMPOSE_FILES api-action api-admin/u);
  const preflight = deploy.indexOf(
    'verify_giveaway_writer_rollout "$(git rev-parse --verify HEAD)" || exit 1',
  );
  const cutoff = deploy.indexOf('quiesce_giveaway_writer_transition || exit 1');
  assert.ok(preflight > 0 && preflight < deploy.indexOf('\nprepare_deploy_disk_capacity\n'));
  assert.ok(cutoff > deploy.indexOf('  maxim_webhook_quiesce_for_api_rollout COMPOSE_FILES\n'));
  assert.ok(cutoff < deploy.indexOf('    if ! run_migrations; then'));
});
