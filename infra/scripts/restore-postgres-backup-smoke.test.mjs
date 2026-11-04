import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { deployLockFixture, deployLockEnvironment } from './test-fixtures/deploy-lock.mjs';

for (const profile of ['maxim', 'eraser']) {
  for (const scenario of [
    'valid',
    'invalid-schema',
    'foreign-checksum',
    'initialization-restart',
    'socket-only-never-ready',
    'pre-run-readiness-failed',
    'loop-volume',
    'loop-cleanup-unknown',
    ...[
      'directory-container-cleanup-failed',
      'directory-data-cleanup-failed',
      'directory-lock-release-failed',
      'loop-lock-release-failed',
    ].flatMap((scenario) => [scenario, `${scenario}-existing-receipt`]),
  ]) {
    const actionScenario = scenario.replace(/-existing-receipt$/u, '');
    const existingReceipt = scenario.endsWith('-existing-receipt');
    const valid = ['valid', 'initialization-restart', 'loop-volume'].includes(scenario);
    const loop = scenario.startsWith('loop-');
    const foreignChecksum = scenario === 'foreign-checksum';
    const cleanupFailure = scenario.includes('cleanup-failed');
    const releaseFailure = scenario.includes('lock-release-failed');
    test(`restore is isolated, cleaned and receipts require authority schema; profile=${profile}, scenario=${scenario}`, (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'maxim-restore-test-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const lock = deployLockFixture(dir);
      const releaseLog = join(dir, 'release.log');
      writeFileSync(
        lock.helper,
        readFileSync(lock.helper, 'utf8').replace(
          'release_deploy_lock() {',
          'fixture_release_deploy_lock() {',
        ) +
          `
release_deploy_lock() {
  printf '%s\\n' release >> "$TEST_RELEASE_LOG"
  if [[ "$TEST_STARTUP_SCENARIO" == *lock-release-failed ]]; then return 1; fi
  fixture_release_deploy_lock
}
`,
      );
      const bin = join(dir, 'bin');
      const backup = join(dir, 'backup');
      const archiveDirectory = profile === 'eraser' ? join(backup, 'eraser') : backup;
      const data = join(dir, 'restore');
      const volumeLog = join(dir, 'volume-actions.log');
      const volumeRoot = join(dir, 'loop-mount');
      const readinessProbes = join(dir, 'readiness-probes');
      for (const path of [bin, backup, data]) mkdirSync(path);
      if (profile === 'eraser') mkdirSync(archiveDirectory);
      writeFileSync(
        join(bin, 'node'),
        `#!/usr/bin/env bash
if [[ "$1" == *check-eraser-backup-readiness.mjs ]]; then exit 0; fi
if [[ "$1" == *lib/postgres-restore-volume.mjs ]]; then
  printf '%s\\n' "$2" >> "$TEST_VOLUME_LOG"
  case "$2" in
    preflight) echo '{}' ;;
    prepare)
      mkdir -p "$TEST_VOLUME_ROOT/data"
      echo '{"mount":"'"$TEST_VOLUME_ROOT"'","data":"'"$TEST_VOLUME_ROOT"'/data"}' ;;
    container-starting)
      echo '{"containerName":"owned-volume-fixture","cidfile":"'"$TEST_VOLUME_ROOT"'/container.cid"}' ;;
    cleanup)
      if [[ "$TEST_STARTUP_SCENARIO" == loop-cleanup-unknown ]]; then exit 1; fi
      rm -rf -- "$TEST_VOLUME_ROOT/data"
      echo '{"cleaned":true}' ;;
    *) exit 1 ;;
  esac
  exit 0
fi
exec '${process.execPath}' "$@"
`,
        { mode: 0o700 },
      );
      const log = join(dir, 'docker.log');
      const removeLog = join(dir, 'remove.log');
      const probes = join(dir, 'tcp-probes');
      writeFileSync(
        join(bin, 'rm'),
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TEST_REMOVE_LOG"
if [[ "$TEST_STARTUP_SCENARIO" == directory-data-cleanup-failed && "$1" == -rf ]]; then exit 1; fi
exec /bin/rm "$@"
`,
        { mode: 0o700 },
      );
      writeFileSync(
        join(bin, 'sleep'),
        '#!/usr/bin/env bash\nif [[ "$1" == 1 ]]; then exit 0; fi\nexec /bin/sleep "$@"\n',
        { mode: 0o700 },
      );
      writeFileSync(
        join(bin, 'fixture-readiness'),
        `#!/usr/bin/env bash
count=0
if [[ -f "$TEST_READINESS_PROBES" ]]; then read -r count < "$TEST_READINESS_PROBES"; fi
count=$((count + 1))
printf '%s\\n' "$count" > "$TEST_READINESS_PROBES"
if [[ "$TEST_STARTUP_SCENARIO" == pre-run-readiness-failed && "$count" == 2 ]]; then exit 1; fi
echo '{"ok":true,"checks":{"database":true,"redis":true,"queueLag":{"rawOk":true,"softWarning":false}}}'
`,
        { mode: 0o700 },
      );
      writeFileSync(join(bin, 'curl'), '#!/bin/sh\nexec fixture-readiness\n', { mode: 0o700 });
      writeFileSync(
        join(bin, 'docker'),
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$TEST_DOCKER_LOG"
if [[ "$TEST_STARTUP_SCENARIO" == directory-container-cleanup-failed && "$1" == rm ]]; then exit 1; fi
if [[ "$TEST_STARTUP_SCENARIO" == pre-run-readiness-failed && "$1" == rm ]]; then
  echo 'No such container' >&2
  exit 1
fi
case "$*" in
  *pg_database_size*) echo 1024 ;;
  *pg_isready*)
    if [[ "$TEST_STARTUP_SCENARIO" == initialization-restart || "$TEST_STARTUP_SCENARIO" == socket-only-never-ready ]]; then
      # The initialization server answers only through the Unix socket, then stops.
      # Final TCP readiness appears only after the simulated shutdown gap.
      if [[ " $* " != *' -h 127.0.0.1 '* ]]; then exit 0; fi
      count=0
      if [[ -f "$TEST_TCP_PROBES" ]]; then read -r count < "$TEST_TCP_PROBES"; fi
      count=$((count + 1))
      printf '%s\\n' "$count" > "$TEST_TCP_PROBES"
      if [[ "$TEST_STARTUP_SCENARIO" == socket-only-never-ready || "$count" -lt 3 ]]; then exit 1; fi
    fi
    ;;
  *createdb*)
    if [[ "$TEST_STARTUP_SCENARIO" == initialization-restart || "$TEST_STARTUP_SCENARIO" == socket-only-never-ready ]]; then
      count=0
      if [[ -f "$TEST_TCP_PROBES" ]]; then read -r count < "$TEST_TCP_PROBES"; fi
      if ((count < 3)); then
        echo 'createdb: connection to server on socket failed: No such file or directory' >&2
        exit 1
      fi
    fi
    ;;
  *pg_restore*) cat >/dev/null ;;
  *psql*-XAtq*) cat >/dev/null; echo "$TEST_SCHEMA_VALID" ;;
  *psql*critical*) echo "$TEST_SCHEMA_VALID" ;;
  *psql*) echo 1 ;;
esac
`,
        { mode: 0o700 },
      );
      const script = join(dir, 'restore.sh');
      writeFileSync(
        script,
        readFileSync(resolve(import.meta.dirname, 'restore-postgres-backup-smoke.sh'), 'utf8')
          .replace(/^ROOT_DIR=.*$/mu, `ROOT_DIR='${resolve(import.meta.dirname, '../..')}'`)
          .replace(
            'source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"',
            `source '${lock.helper}'`,
          ),
      );
      const name = `${profile}_20261013T000000Z.dump`;
      const dump = join(archiveDirectory, name);
      const bytes = 'synthetic restore fixture';
      writeFileSync(dump, bytes);
      writeFileSync(
        `${dump}.sha256`,
        `${createHash('sha256').update(bytes).digest('hex')}  ${foreignChecksum ? 'unrelated.dump' : name}\n`,
      );
      writeFileSync(join(backup, 'unrelated.dump'), bytes);
      const receipt = `${dump}.restore-verified.json`;
      const priorReceipt = '{"previous":"verified receipt must be preserved"}\n';
      if (existingReceipt) writeFileSync(receipt, priorReceipt);
      const env = deployLockEnvironment({
        PATH: `${bin}:${process.env.PATH}`,
        MAXIM_BACKUP_DIR: backup,
        MAXIM_BACKUP_BACKING_FILESYSTEM_PATH: dir,
        MAXIM_BACKUP_PROFILE: profile,
        MAXIM_RESTORE_SMOKE_DATA_ROOT: data,
        MAXIM_RESTORE_SMOKE_MIN_FREE_BYTES: '1024',
        MAXIM_RESTORE_SMOKE_REQUIRE_DEDICATED_FILESYSTEM: '0',
        MAXIM_RESTORE_SMOKE_MAXIM_LOOP_BYTES: loop && profile === 'maxim' ? '8000000000' : '0',
        MAXIM_RESTORE_SMOKE_ERASER_LOOP_BYTES: loop && profile === 'eraser' ? '8000000000' : '0',
        MAXIM_BACKUP_POSTGRES_IMAGE: 'sha256:fixture',
        MAXIM_BACKUP_COMPOSE_FILE: join(dir, 'group-backup', 'docker-compose.yml'),
        TEST_DOCKER_LOG: log,
        TEST_TCP_PROBES: probes,
        TEST_STARTUP_SCENARIO: actionScenario,
        TEST_SCHEMA_VALID:
          valid || scenario === 'loop-cleanup-unknown' || cleanupFailure || releaseFailure
            ? '1'
            : '0',
        TEST_VOLUME_LOG: volumeLog,
        TEST_VOLUME_ROOT: volumeRoot,
        TEST_REMOVE_LOG: removeLog,
        TEST_RELEASE_LOG: releaseLog,
        TEST_READINESS_PROBES: readinessProbes,
      });
      const result = spawnSync('bash', [script], { env, encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status === 0, valid, result.stderr);
      if (!valid) assert.doesNotMatch(result.stdout, /PostgreSQL restore smoke passed/u);
      assert.equal(existsSync(receipt), valid || existingReceipt);
      if (existingReceipt) assert.equal(readFileSync(receipt, 'utf8'), priorReceipt);
      assert.deepEqual(
        readdirSync(archiveDirectory).filter((name) => name.endsWith('.tmp')),
        [],
      );
      const remainingData = readdirSync(
        profile === 'eraser' && !foreignChecksum && !loop ? join(data, 'eraser') : data,
      );
      if (cleanupFailure) assert.equal(remainingData.length, 1);
      else assert.deepEqual(remainingData, []);
      if (foreignChecksum) {
        assert.equal(existsSync(log), false);
        assert.equal(spawnSync('flock', ['-n', lock.file, 'true']).status, 0);
        return;
      }
      const operations = readFileSync(log, 'utf8');
      if (scenario === 'pre-run-readiness-failed') {
        assert.equal(readFileSync(readinessProbes, 'utf8'), '2\n');
        assert.doesNotMatch(operations, /^(?:run|rm|exec) /mu);
        assert.equal(readFileSync(releaseLog, 'utf8'), 'release\n');
        assert.equal(spawnSync('flock', ['-n', lock.file, 'true']).status, 0);
        return;
      }
      if (scenario === 'initialization-restart') {
        assert.equal(readFileSync(probes, 'utf8'), '3\n');
        assert.equal(operations.match(/pg_isready/g)?.length, 3);
        assert.match(operations, /createdb -U postgres/u);
      } else if (scenario === 'socket-only-never-ready') {
        assert.equal(readFileSync(probes, 'utf8'), '60\n');
        assert.match(result.stderr, /Disposable PostgreSQL did not become ready/u);
        assert.doesNotMatch(operations, /^exec[^\n]*\s(?:createdb|pg_restore|psql)(?:\s|$)/mu);
      }
      assert.match(operations, /--network none --cpus 2 --memory 4g --pids-limit 128/u);
      if (loop) {
        assert.match(operations, /--cidfile .* --label maxim.restore.operation=/);
        assert.doesNotMatch(operations, /^rm -f /m);
        const actions = readFileSync(volumeLog, 'utf8').trim().split('\n');
        assert.deepEqual(actions.slice(0, 3), ['preflight', 'prepare', 'container-starting']);
        assert.equal(actions.filter((action) => action === 'cleanup').length, 1);
        assert.equal(existsSync(receipt), scenario === 'loop-volume' || existingReceipt);
      } else {
        assert.ok(
          operations.includes(
            `rm -f ${profile === 'eraser' ? 'maxim-eraser' : 'maxim'}-postgres-restore-smoke-`,
          ),
        );
      }
      if (profile === 'eraser') assert.match(operations, /exec -T eraser-postgres/);
      assert.doesNotMatch(
        operations,
        /^compose[^\n]*\s(?:up|down)(?:\s|$)|^rm -f (?:postgres|infra-postgres)/mu,
      );
      if (actionScenario === 'directory-container-cleanup-failed') {
        assert.equal(operations.match(/^rm -f /gm)?.length, 1);
        assert.doesNotMatch(
          existsSync(removeLog) ? readFileSync(removeLog, 'utf8') : '',
          /^-rf /mu,
        );
      }
      assert.equal(readFileSync(releaseLog, 'utf8'), 'release\n');
      assert.equal(spawnSync('flock', ['-n', lock.file, 'true']).status, 0);
    });
  }
}
