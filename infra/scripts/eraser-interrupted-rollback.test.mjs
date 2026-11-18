import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { beginReleaseTransition, buildReleaseManifest } from './release-manifest.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const rollback = readFileSync(new URL('./vps-release-rollback.sh', import.meta.url), 'utf8');
const selection = rollback.match(/^select_release_recovery_base\(\) \{[\s\S]*?^\}$/mu)?.[0];
assert.ok(selection);
const alternateStackGate = rollback
  .split('\nselect_release_recovery_base\n\n')[1]
  ?.split('\nMAXIM_RELEASE_STATE_DIR=')[0];
assert.ok(alternateStackGate);

test('immutable rollback requires a successful empty alternative stack census', () => {
  for (const [state, status, message] of [
    ['stopped', 0, /admitted/u],
    ['running', 1, /infra-scale is running/u],
    ['unknown', 1, /cannot verify that infra-scale is stopped/u],
  ]) {
    const result = spawnSync(
      'bash',
      [
        '-eu',
        '-c',
        `
SCALE_COMPOSE_FILES=(-p infra-scale)
docker() {
  [[ "$*" == 'compose -p infra-scale ps --status running --services' ]] || return 40
  case "$SCALE_STATE" in
    stopped) return 0 ;;
    running) printf '%s\\n' api-ingress ;;
    unknown) return 17 ;;
  esac
}
SCALE_STATE="$1"
${alternateStackGate}
printf '%s\\n' admitted
`,
        'fixture',
        state,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, status, result.stderr);
    assert.match(result.stdout + result.stderr, message);
    if (status) assert.equal(result.stdout, '');
  }
});

const baselineId = 'release-20261118T010000Z-aaaaaaaaaaaa';
const previousSha = 'a'.repeat(40);
const nextSha = 'b'.repeat(40);
const writeManifest = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
function component(id, sha, image) {
  return {
    id,
    sourceSha: sha,
    imageRef: `maxim-${id}:${sha}`,
    imageId: `sha256:${image.repeat(64)}`,
  };
}

function fixture(t, { kind = 'deploy-eraser', committed = false, change, rollback = false } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'maxim-eraser-recovery-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const releases = join(stateDir, 'releases');
  mkdirSync(releases);
  const current = join(stateDir, 'current.json');
  const baseline = buildReleaseManifest({
    releaseId: baselineId,
    targetSha: previousSha,
    createdAt: '2026-11-18T01:00:00.000Z',
    components: ['api-shared', 'miniapp-major-static', 'admin-static', 'eraser'].map((id, i) =>
      component(id, id === 'eraser' ? 'c'.repeat(40) : previousSha, String(i + 1)),
    ),
    migrations: ['schema-a'],
    smokes: ['strict-api'],
  });
  const baselineCopy = join(releases, baselineId + '.json');
  writeManifest(baselineCopy, baseline);
  writeManifest(current, baseline);
  const journal = beginReleaseTransition({
    stateDir,
    kind,
    now: new Date('2026-11-18T02:00:00.000Z'),
    pid: 1,
  });
  let committedCopy;
  if (committed) {
    const next = structuredClone(
      buildReleaseManifest({
        current: baseline,
        releaseId: rollback
          ? 'rollback-20261118T020001000Z-aaaaaaaaaaaa-77'
          : 'release-20261118T020001Z-bbbbbbbbbbbb',
        targetSha: rollback ? baseline.targetSha : nextSha,
        createdAt: '2026-11-18T02:00:01.000Z',
        components: [
          rollback
            ? { id: 'eraser', ...baseline.components.eraser }
            : component('eraser', nextSha, '5'),
        ],
        smokes: ['eraser-exact-source-ready'],
        emergencyReason: rollback ? `immutable rollback to ${baselineId}` : null,
      }),
    );
    change?.(next);
    committedCopy = join(releases, next.releaseId + '.json');
    writeManifest(committedCopy, next);
    writeManifest(current, next);
  }
  return { stateDir, journal, current, committedCopy, baselineCopy };
}

function select({ stateDir }, { adopt = '1', target = baselineId, components = ['eraser'] } = {}) {
  return spawnSync(
    'bash',
    [
      '-eu',
      '-c',
      `
RELEASE_STATE_DIR="$1" MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE="$2" SOURCE_RELEASE_ID="$3"
shift 3
REQUESTED_COMPONENTS=("$@")
RECOVERY_BASE_MANIFEST='' RECOVERY_REQUIRES_API_FENCE=0
${selection}
select_release_recovery_base
printf 'RECOVERY=%s\\nAPI_FENCE=%s\\n' "$RECOVERY_BASE_MANIFEST" "$RECOVERY_REQUIRES_API_FENCE"
`,
      'fixture',
      stateDir,
      adopt,
      target,
      ...components,
    ],
    { cwd: root, encoding: 'utf8', env: { ...process.env, BASH_ENV: '/dev/null' } },
  );
}

function withdraw({ stateDir, journal }, adopt = '1') {
  return spawnSync(
    process.execPath,
    [
      'infra/scripts/release-manifest.mjs',
      'eraser-recovery',
      '--release-id',
      baselineId,
      '--current-manifest-file',
      journal,
      '--withdraw-current',
      '1',
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        MAXIM_RELEASE_STATE_DIR: stateDir,
        MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE: adopt,
      },
      encoding: 'utf8',
    },
  );
}

test('validate the exact immutable Lastik rollback baseline without changing release state', (t) => {
  const { stateDir, journal, current, baselineCopy } = fixture(t);
  renameSync(journal, current);
  const original = readFileSync(current);
  const unknown = join(stateDir, 'current.invalid-unrecognized.json');
  const snapshot = () =>
    readdirSync(stateDir, { recursive: true })
      .sort()
      .map((name) => {
        const file = join(stateDir, name);
        const info = lstatSync(file);
        if (info.isSymbolicLink()) return [name, 'link', readlinkSync(file)];
        return info.isDirectory() ? [name, 'directory'] : [name, 'file', readFileSync(file)];
      });
  const validate = (label, valid = false) => {
    const before = snapshot();
    const result = spawnSync(
      process.execPath,
      ['infra/scripts/release-manifest.mjs', 'validate-current', '--eraser-rollback-baseline', '1'],
      { cwd: root, encoding: 'utf8', env: { ...process.env, MAXIM_RELEASE_STATE_DIR: stateDir } },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status === 0, valid, label + ': ' + result.stderr);
    assert.deepEqual(snapshot(), before, label);
  };
  validate('exact copy', true);
  rmSync(baselineCopy);
  validate('missing copy');
  writeFileSync(baselineCopy, Buffer.concat([original, Buffer.from(' ')]));
  validate('different bytes for the same JSON');
  rmSync(baselineCopy);
  symlinkSync(current, baselineCopy);
  validate('symlink to the exact bytes');
  rmSync(baselineCopy);
  writeFileSync(baselineCopy, original);
  writeFileSync(unknown, original);
  validate('unrecognized transition');
});

for (const committed of [false, true]) {
  test(`adopt only the recorded Lastik baseline with committed current=${committed}`, (t) => {
    const data = fixture(t, { committed });
    const baselineBytes = readFileSync(data.journal, 'utf8');
    const committedBytes = committed && readFileSync(data.current, 'utf8');
    for (const options of [
      { adopt: '0' },
      { target: 'different-release' },
      { components: [] },
      { components: ['api-shared'] },
      { components: ['eraser', 'admin-static'] },
    ]) {
      const result = select(data, options);
      assert.notEqual(result.status, 0, JSON.stringify(options));
      assert.equal(existsSync(data.current), committed);
      if (committed) assert.equal(readFileSync(data.current, 'utf8'), committedBytes);
    }
    const admitted = select(data);
    assert.equal(admitted.status, 0, admitted.stderr);
    assert.ok(admitted.stdout.includes(`RECOVERY=${data.journal}\nAPI_FENCE=0\n`));
    assert.equal(existsSync(data.current), committed);
    if (committed) {
      assert.notEqual(withdraw(data, '0').status, 0);
      assert.equal(readFileSync(data.current, 'utf8'), committedBytes);
    }
    const withdrawal = withdraw(data);
    assert.equal(withdrawal.status, 0, withdrawal.stderr);
    assert.equal(existsSync(data.current), false);
    assert.equal(readFileSync(data.journal, 'utf8'), baselineBytes);
    assert.equal(readFileSync(data.baselineCopy, 'utf8'), baselineBytes);
    if (committed) assert.equal(readFileSync(data.committedCopy, 'utf8'), committedBytes);
    assert.equal(select(data).status, 0, 'retry after withdrawing current must remain possible');
  });
}

test('retry after rollback committed a mixed-source baseline but did not archive the journal', (t) => {
  const data = fixture(t, { committed: true, rollback: true });
  const receipt = JSON.parse(readFileSync(data.current, 'utf8'));
  assert.notEqual(receipt.components.eraser.sourceSha, receipt.targetSha);
  const admitted = select(data);
  assert.equal(admitted.status, 0, admitted.stderr);
  assert.ok(admitted.stdout.includes(`RECOVERY=${data.journal}\nAPI_FENCE=0\n`));
  const withdrawal = withdraw(data);
  assert.equal(withdrawal.status, 0, withdrawal.stderr);
  assert.equal(existsSync(data.current), false);
  assert.deepEqual(JSON.parse(readFileSync(data.committedCopy, 'utf8')), receipt);
  assert.ok(existsSync(data.journal));
});

test('reject an unverifiable committed successor and preserve all records', (t) => {
  for (const change of [
    (manifest) => {
      manifest.components['api-shared'].imageId = 'sha256:' + '8'.repeat(64);
    },
    (manifest) => {
      manifest.migrations.push('unexpected');
    },
    (manifest) => {
      manifest.createdAt = '2025-11-18T01:00:00.000Z';
    },
    (manifest) => {
      manifest.smokes = [];
    },
    (manifest) => {
      manifest.components.eraser.recordedAt = '2026-11-18T01:00:00.000Z';
    },
    (manifest) => {
      manifest.targetSha = previousSha;
    },
  ]) {
    const data = fixture(t, { committed: true, change });
    const before = readFileSync(data.current, 'utf8');
    assert.notEqual(select(data).status, 0);
    assert.notEqual(withdraw(data).status, 0);
    assert.equal(readFileSync(data.current, 'utf8'), before);
    assert.equal(readFileSync(data.committedCopy, 'utf8'), before);
    assert.ok(existsSync(data.journal));
  }
});

test('journal and current must match their respective immutable release records', (t) => {
  for (const copy of ['baselineCopy', 'committedCopy']) {
    const data = fixture(t, { committed: true });
    const divergent = JSON.parse(readFileSync(data[copy], 'utf8'));
    divergent.components.eraser.imageId = 'sha256:' + '9'.repeat(64);
    writeManifest(data[copy], divergent);
    assert.notEqual(select(data).status, 0);
    assert.notEqual(withdraw(data).status, 0);
    assert.ok(existsSync(data.current));
    assert.ok(existsSync(data.journal));
  }
});

test('an unarchived generic deploy never gets Lastik-only treatment', (t) => {
  const interrupted = fixture(t, { kind: 'deploy' });
  const withoutCurrent = select(interrupted);
  assert.equal(withoutCurrent.status, 0, withoutCurrent.stderr);
  assert.ok(withoutCurrent.stdout.includes('API_FENCE=1\n'));
  const coexisting = fixture(t, { kind: 'deploy', committed: true });
  assert.notEqual(select(coexisting).status, 0);
  const duplicate = fixture(t, { committed: true });
  writeFileSync(
    join(duplicate.stateDir, basename(interrupted.journal)),
    readFileSync(interrupted.journal),
  );
  assert.notEqual(select(duplicate).status, 0);
  assert.notEqual(withdraw(duplicate).status, 0);
  assert.equal(
    readdirSync(duplicate.stateDir).filter((name) => name.startsWith('current.invalid-')).length,
    2,
  );
  assert.ok(existsSync(duplicate.current));
});
