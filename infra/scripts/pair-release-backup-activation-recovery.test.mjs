import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  readFile,
  mkdtemp,
  writeFile,
  lstat,
  rm,
  access,
  symlink,
  rename,
  utimes,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ACTIVATION,
  parseBackupActivationRecoveryArgs,
  buildBackupActivationProof,
  recoverBackupActivation,
  withActivationSchedulerLock,
  validateActivationOcrRestart,
  observeActivationOcrRestart,
  observeActivationUnitProperties,
  observeActivationSourceGit,
  parseActivationUnitProperties,
} from './pair-release-backup-activation-recovery.mjs';
import {
  withBackupRefusalLocks,
  archiveBackupRefusal,
} from './pair-release-backup-refusal-recovery.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const BOOT = '01234567-89ab-cdef-0123-456789abcdef';
const root = '/var/www/Chat_bot';
const roles = [
  'api-ingress',
  'api-admin',
  'api-enqueue',
  'api-moderation',
  'api-moderation-critical',
  'api-moderation-join',
  'api-moderation-realtime-b',
  'api-moderation-realtime-c',
  'api-moderation-realtime-d',
  'api-moderation-background',
  'api-media-analysis',
  'api-action',
  'api-publisher',
  'api-message-retention',
  'ocr-native-sandbox',
  'photo-native-sandbox',
  'eraser',
  'postgres',
  'redis',
  'eraser-postgres',
  'eraser-redis',
  'miniapp-major-static',
  'admin-static',
];
const image = `sha256:${'a'.repeat(64)}`;
const argv = (value) =>
  `{ path=${value.split(' ')[0]}; argv[]=${value}; ignore_errors=no; start_time=[n/a]; stop_time=[n/a]; pid=0; code=(null); status=0/0 }`;

async function unitsFixture() {
  // Interpret only the installer’s literal unit templates; never execute the installer.
  const source = await readFile(
    new URL('./vps-install-postgres-backup-timers.sh', import.meta.url),
    'utf8',
  );
  const units = {};
  for (const profile of ['maxim', 'eraser']) {
    const eraser = profile === 'eraser';
    const prefix = eraser ? 'maxim-eraser-postgres' : 'maxim-postgres';
    const variables = {
      ROOT_DIR: root,
      MAXIM_BACKUP_PROFILE: profile,
      MAXIM_BACKUP_UNIT_PREFIX: prefix,
      PROFILE_PRECHECK: eraser
        ? `ExecStartPre=/usr/bin/test -f ${root}/infra/scripts/lib/postgres-backup-profile.sh`
        : '',
      BACKUP_CALENDAR: eraser ? '*-*-* 01:20:00' : '*-*-* 03:20:00',
      RESTORE_CALENDAR: eraser ? 'Sun *-*-* 02:30:00' : 'Sun *-*-* 05:30:00',
    };
    const fragments = {};
    for (const match of source.matchAll(
      /cat > "\$TEMP_DIR\/\$\{MAXIM_BACKUP_UNIT_PREFIX\}-(.+)" <<EOF\n([\s\S]*?)\nEOF/gu,
    )) {
      fragments[`${prefix}-${match[1]}`] = `${match[2]}\n`.replace(
        /\$\{([A-Z_]+)\}|\$([A-Z_]+)/gu,
        (_, braces, plain) => {
          assert.ok(Object.hasOwn(variables, braces ?? plain));
          return variables[braces ?? plain];
        },
      );
    }
    fragments[`${prefix}-backup-retry.service`] = fragments[`${prefix}-backup.service`].replace(
      'postgres-backup-schedule.sh request',
      'postgres-backup-schedule.sh tick',
    );
    for (const [name, bytes] of Object.entries(fragments)) {
      const timer = name.endsWith('.timer');
      const enabled = timer && eraser && !name.includes('-retry.');
      const failed =
        name === 'maxim-postgres-backup.service' || name === 'maxim-postgres-backup-retry.service';
      const p = {
        Id: name,
        LoadState: 'loaded',
        ActiveState: timer ? (enabled ? 'active' : 'inactive') : failed ? 'failed' : 'inactive',
        SubState: timer ? (enabled ? 'waiting' : 'dead') : failed ? 'failed' : 'dead',
        FragmentPath: `/etc/systemd/system/${name}`,
        DropInPaths: '',
        OnFailure: '',
        OnSuccess: '',
        NeedDaemonReload: 'no',
        UnitFileState: timer ? (enabled ? 'enabled' : 'disabled') : 'static',
        Result: failed ? 'exit-code' : 'success',
        InvocationID: '',
        LastTriggerUSec: '',
        NextElapseUSecRealtime: enabled ? new Date(Date.now() + 86_400_000).toUTCString() : '',
      };
      if (!timer) {
        Object.assign(p, {
          MainPID: '0',
          ControlPID: '0',
          ControlGroup: '',
          User: '',
          Group: '',
          Environment: '',
          PassEnvironment: '',
          UnsetEnvironment: '',
          RootDirectory: '',
          RootImage: '',
          ExecCondition: '',
          ExecStartPost: '',
          ExecStop: '',
          ExecStopPost: '',
          WorkingDirectory: root,
          EnvironmentFiles: `/etc/maxim-postgres-backup.env (ignore_errors=${name.includes('-health.') ? 'no' : 'yes'})`,
          ExecMainStatus: failed ? '1' : '0',
          ExecMainCode: failed ? '1' : '0',
          ExecMainStartTimestamp: '',
          ExecMainExitTimestamp: '',
          ExecStart: argv(bytes.match(/^ExecStart=(.+)$/mu)[1]),
          ExecStartPre: [...bytes.matchAll(/^ExecStartPre=(.+)$/gmu)]
            .map((match) => argv(match[1]))
            .join(' '),
        });
        if (name === 'maxim-postgres-backup-retry.service')
          Object.assign(p, {
            InvocationID: ACTIVATION.invocationId,
            ExecMainStartTimestamp: 'Tue 2026-11-03 10:42:07 UTC',
            ExecMainExitTimestamp: 'Tue 2026-11-03 10:42:07 UTC',
          });
        else if (name === 'maxim-eraser-postgres-backup-health.service')
          Object.assign(p, {
            InvocationID: 'b'.repeat(32),
            ExecMainCode: '1',
            ExecMainStartTimestamp: 'Tue 2026-11-03 10:42:07 UTC',
            ExecMainExitTimestamp: 'Tue 2026-11-03 10:42:07 UTC',
          });
        else if (failed)
          Object.assign(p, {
            InvocationID: 'c'.repeat(32),
            ExecMainStartTimestamp: 'Tue 2026-11-03 07:59:05 UTC',
            ExecMainExitTimestamp: 'Tue 2026-11-03 08:13:44 UTC',
          });
      }
      units[name] = { sha256: digest(bytes), uid: 0, mode: 0o644, properties: p };
    }
  }
  return units;
}
async function fixture() {
  const snapshot = {
    schemaVersion: 1,
    protocol: 'major-karavan-release-v1',
    major: {
      checkoutSha: ACTIVATION.sourceSha,
      components: ['api-shared', 'eraser', 'miniapp-major-static', 'admin-static'].map((id) => ({
        id,
        imageId: image,
        sourceSha: ACTIVATION.sourceSha,
      })),
    },
    karavan: { checkoutSha: 'b'.repeat(40) },
    configuration: { majorSha256: 'c'.repeat(64), karavanSha256: 'd'.repeat(64) },
  };
  const stateSha256 = digest(JSON.stringify(snapshot));
  // Synthetic owner; production CLI independently pins the actual incident hash.
  const ownerBytes = Buffer.from(
    `protocol=major-karavan-release-v1\ntoken=${BOOT}\nproduct=major\nmode=runtime\ntarget=\npid=12345\nstart=12345\nboot=${BOOT}\ncwd=${digest(root)}\nfd=10\ninode=57:12345\ninitial_state=${stateSha256}\nstarted_at=${ACTIVATION.startedAt}\n`,
  );
  const request = {
    mode: 'preview',
    ownerSha256: digest(ownerBytes),
    stateSha256,
    sourceSha: ACTIVATION.sourceSha,
    invocationId: ACTIVATION.invocationId,
  };
  const runtime = roles.map((role, index) => {
    const store = ['postgres', 'redis', 'eraser-postgres', 'eraser-redis'].includes(role);
    const volume = `infra_${role.replaceAll('-', '_')}_data`;
    return {
      id: (index + 1).toString(16).padStart(64, '0'),
      name: `/infra-${role}-1`,
      image,
      imageRef: 'fixture',
      status: 'running',
      created: '2026-11-03T10:00:00Z',
      started: '2026-11-03T10:01:00Z',
      restarts: 0,
      mounts: store
        ? [
            {
              Destination: role.endsWith('postgres') ? '/var/lib/postgresql/data' : '/data',
              Type: 'volume',
              Name: volume,
              Source: `/var/lib/docker/volumes/${volume}/_data`,
              RW: true,
            },
          ]
        : [],
    };
  });
  const messages = [
    "fatal: detected dubious ownership in repository at '/var/www/Chat_bot'",
    'To add an exception for this directory, call:',
    '\tgit config --global --add safe.directory /var/www/Chat_bot',
    'Backup schedule refused: inspect private state and service journal.',
  ];
  const journal = messages.map((MESSAGE) => ({
    MESSAGE,
    __REALTIME_TIMESTAMP: '1793702527963163',
    _SYSTEMD_INVOCATION_ID: ACTIVATION.invocationId,
    _SYSTEMD_UNIT: 'maxim-postgres-backup-retry.service',
    _SYSTEMD_CGROUP: '/system.slice/maxim-postgres-backup-retry.service',
    _UID: '0',
    _GID: '0',
    _BOOT_ID: BOOT.replaceAll('-', ''),
    _EXE: '/usr/local/bin/node',
    _CMDLINE: `node ${root}/infra/scripts/postgres-backup-schedule.mjs tick`,
    _PID: '12346',
  }));
  return {
    request,
    observation: {
      root: true,
      locksHeld: true,
      ownerBytes,
      ownerUid: 1000,
      ownerMode: 0o600,
      ownerLinks: 1,
      operatorUid: 1000,
      admissionInode: '57:12345',
      bootId: BOOT,
      originalProcessAbsent: true,
      noActors: true,
      sourcesMatch: true,
      environmentSha256: ACTIVATION.environmentSha256,
      schedulerEmpty: true,
      schedulerSha256: 'e'.repeat(64),
      snapshot,
      units: await unitsFixture(),
      runtime,
      journal,
    },
  };
}
const cli = (mode = 'preview') => [
  mode,
  '--owner-sha256',
  ACTIVATION.ownerSha256,
  '--state-sha256',
  ACTIVATION.stateSha256,
  '--source-sha',
  ACTIVATION.sourceSha,
  '--invocation-id',
  ACTIVATION.invocationId,
  ...(mode === 'apply' ? ['--proof-sha256', 'f'.repeat(64)] : []),
];

test('production CLI admits only the exact incident and requires reviewed proof for apply', () => {
  assert.equal(parseBackupActivationRecoveryArgs(cli()).ownerSha256, ACTIVATION.ownerSha256);
  assert.equal(parseBackupActivationRecoveryArgs(cli('apply')).proofSha256, 'f'.repeat(64));
  for (const index of [2, 4, 6, 8]) {
    const args = cli();
    args[index] = '0'.repeat(args[index].length);
    assert.throws(() => parseBackupActivationRecoveryArgs(args), /unreviewed_activation_identity/u);
  }
  assert.throws(
    () => parseBackupActivationRecoveryArgs(['apply', ...cli().slice(1)]),
    /invalid_arguments/u,
  );
  assert.throws(
    () => parseBackupActivationRecoveryArgs([...cli(), '--proof-sha256', 'f'.repeat(64)]),
    /invalid_arguments/u,
  );
});

test('exact installed unit templates and no-operation evidence produce a bounded truthful proof', async () => {
  const { request, observation } = await fixture();
  const proof = buildBackupActivationProof(request, observation);
  assert.equal(proof.kind, 'backup-scheduler-partial-activation');
  assert.equal(proof.verification, 'installed_units_and_git_refusal_before_operation_or_producer');
  assert.match(proof.eraserCoordinator, /absent_not_locked/u);
  assert.match(proof.runtimeEvidence, /no_prior_container_inventory/u);
  assert.ok(Buffer.byteLength(JSON.stringify(proof)) < 4096);
  assert.ok(!JSON.stringify(proof).includes(BOOT));
});

for (const [name, alter] of [
  [
    'changed owner bytes',
    (o) => {
      o.ownerBytes = Buffer.from(o.ownerBytes.toString().replace('pid=12345', 'pid=12344'));
    },
  ],
  [
    'root-owned owner',
    (o) => {
      o.ownerUid = 0;
    },
  ],
  [
    'unsafe owner mode',
    (o) => {
      o.ownerMode = 0o644;
    },
  ],
  [
    'linked owner',
    (o) => {
      o.ownerLinks = 2;
    },
  ],
  [
    'live original holder',
    (o) => {
      o.originalProcessAbsent = false;
    },
  ],
  [
    'different boot',
    (o) => {
      o.bootId = '0'.repeat(36);
    },
  ],
  [
    'different admission inode',
    (o) => {
      o.admissionInode = '57:1';
    },
  ],
  [
    'remaining actor',
    (o) => {
      o.noActors = false;
    },
  ],
  [
    'missing release locks',
    (o) => {
      o.locksHeld = false;
    },
  ],
  [
    'changed source',
    (o) => {
      o.sourcesMatch = false;
    },
  ],
  [
    'changed backup environment',
    (o) => {
      o.environmentSha256 = 'f'.repeat(64);
    },
  ],
  [
    'scheduler artifacts',
    (o) => {
      o.schedulerEmpty = false;
    },
  ],
  [
    'changed pair state',
    (o) => {
      o.snapshot.configuration.majorSha256 = 'f'.repeat(64);
    },
  ],
  [
    'partial journal',
    (o) => {
      o.journal.pop();
    },
  ],
  [
    'journal overflow',
    (o) => {
      o.journal.push(o.journal[0]);
    },
  ],
  [
    'foreign invocation',
    (o) => {
      o.journal[0]._SYSTEMD_INVOCATION_ID = 'f'.repeat(32);
    },
  ],
  [
    'foreign journal user',
    (o) => {
      o.journal[0]._UID = '1000';
    },
  ],
  [
    'foreign journal executable',
    (o) => {
      o.journal[0]._EXE = '/bin/bash';
    },
  ],
  [
    'late journal outcome',
    (o) => {
      o.journal[3].__REALTIME_TIMESTAMP = '1793702528963163';
    },
  ],
  [
    'different loaded command',
    (o) => {
      o.units['maxim-postgres-backup-retry.service'].properties.ExecStart = argv('/bin/true');
    },
  ],
  [
    'unit hook',
    (o) => {
      o.units['maxim-postgres-backup-retry.service'].properties.ExecStartPost = argv('/bin/true');
    },
  ],
  [
    'changed fragment',
    (o) => {
      o.units['maxim-postgres-backup-retry.service'].sha256 = 'f'.repeat(64);
    },
  ],
  [
    'pending daemon reload',
    (o) => {
      o.units['maxim-postgres-backup-retry.service'].properties.NeedDaemonReload = 'yes';
    },
  ],
  [
    'enabled main retry',
    (o) => {
      o.units['maxim-postgres-backup-retry.timer'].properties.UnitFileState = 'enabled';
    },
  ],
  [
    'imminent eraser backup',
    (o) => {
      o.units['maxim-eraser-postgres-backup.timer'].properties.NextElapseUSecRealtime = new Date(
        Date.now() + 60_000,
      ).toUTCString();
    },
  ],
  [
    'retry re-execution',
    (o) => {
      o.units['maxim-postgres-backup-retry.service'].properties.InvocationID = 'f'.repeat(32);
    },
  ],
  [
    'active service child',
    (o) => {
      o.units['maxim-postgres-backup-retry.service'].properties.ControlPID = '123';
    },
  ],
  [
    'new runtime generation',
    (o) => {
      o.runtime[0].created = '2026-11-03T10:43:00Z';
      o.runtime[0].started = '2026-11-03T10:43:01Z';
    },
  ],
  [
    'changed runtime image',
    (o) => {
      o.runtime[0].image = `sha256:${'f'.repeat(64)}`;
    },
  ],
  [
    'missing runtime role',
    (o) => {
      o.runtime.pop();
    },
  ],
  [
    'changed store volume',
    (o) => {
      o.runtime.find((item) => item.name === '/infra-postgres-1').mounts[0].Name = 'other';
    },
  ],
])
  test(`refuses ${name} without producing recovery authority`, async () => {
    const { request, observation } = await fixture();
    alter(observation);
    assert.throws(() => buildBackupActivationProof(request, observation));
  });

test('preview never archives; apply binds the reviewed proof and repeated observation', async () => {
  const { request, observation } = await fixture();
  let archives = 0;
  const dependencies = {
    observe: async () => observation,
    archive: async () => {
      archives++;
    },
  };
  const preview = await recoverBackupActivation(request, dependencies);
  assert.equal(archives, 0);
  assert.equal(preview.archived, false);
  await assert.rejects(
    recoverBackupActivation(
      { ...request, mode: 'apply', proofSha256: '0'.repeat(64) },
      dependencies,
    ),
    /preview_proof_changed/u,
  );
  assert.equal(archives, 0);
  const applied = await recoverBackupActivation(
    { ...request, mode: 'apply', proofSha256: preview.proofSha256 },
    dependencies,
  );
  assert.equal(applied.archived, true);
  assert.equal(archives, 1);
  let samples = 0;
  await assert.rejects(
    recoverBackupActivation(
      { ...request, mode: 'apply', proofSha256: preview.proofSha256 },
      {
        ...dependencies,
        observe: async () => {
          const value = structuredClone(observation);
          if (++samples > 1) value.runtime[0].restarts++;
          return value;
        },
      },
    ),
    /recovery_evidence_changed/u,
  );
  assert.equal(archives, 1);
});

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'activation-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
test('existing scheduler lock is actually held through callback and preserves its inode', async (t) => {
  const directory = await temporary(t);
  const path = join(directory, 'lock');
  await writeFile(path, '', { mode: 0o600 });
  const inode = (await lstat(path)).ino;
  await withActivationSchedulerLock(path, async (assertLock) => {
    await assertLock();
    assert.notEqual(spawnSync('flock', ['-n', path, 'true']).status, 0);
  });
  assert.equal(spawnSync('flock', ['-n', path, 'true']).status, 0);
  assert.equal((await lstat(path)).ino, inode);
});
test('missing or symlinked scheduler lock is refused without provisioning it', async (t) => {
  const directory = await temporary(t);
  const path = join(directory, 'missing');
  await assert.rejects(
    withActivationSchedulerLock(path, async () => assert.fail('must not acquire')),
  );
  await assert.rejects(access(path));
  const target = join(directory, 'target');
  await writeFile(target, '');
  await symlink(target, path);
  await assert.rejects(
    withActivationSchedulerLock(path, async () => assert.fail('must not acquire')),
  );
});
test('new partial-activation proof archives unchanged synthetic owner using original three lock descriptions', async (t) => {
  const directory = await temporary(t);
  const { request, observation } = await fixture();
  const proof = buildBackupActivationProof(request, observation);
  const ownerPath = join(directory, 'owner');
  await writeFile(ownerPath, observation.ownerBytes, { mode: 0o600 });
  const before = await lstat(ownerPath);
  const paths = [0, 1, 2].map((index) => join(directory, `release-${index}`));
  for (const path of paths) await writeFile(path, '', { mode: 0o600 });
  const scheduler = join(directory, 'scheduler');
  await writeFile(scheduler, '', { mode: 0o600 });
  const archiveDirectory = join(directory, 'archive');
  await withBackupRefusalLocks(paths, ({ assertLocks }) =>
    withActivationSchedulerLock(scheduler, async (assertScheduler) => {
      const assertAll = async () => {
        await assertLocks();
        await assertScheduler();
      };
      await archiveBackupRefusal({
        ownerPath,
        archiveDirectory,
        operatorUid: process.getuid(),
        operatorGid: process.getgid(),
        ownerBytes: observation.ownerBytes,
        proof,
        assertLocks: assertAll,
      });
    }),
  );
  const archived = join(archiveDirectory, `${request.ownerSha256}.owner`);
  const after = await lstat(archived);
  assert.deepEqual(await readFile(archived), observation.ownerBytes);
  assert.equal(after.ino, before.ino);
  assert.equal(after.uid, before.uid);
  assert.deepEqual(
    JSON.parse(await readFile(join(archiveDirectory, `${request.ownerSha256}.proof.json`), 'utf8')),
    proof,
  );
  await assert.rejects(access(ownerPath));
});

test('completed periodic health keeps the same semantic proof while preserving producer history', async () => {
  const { request, observation } = await fixture();
  const before = buildBackupActivationProof(request, observation);
  const next = structuredClone(observation);
  const service = next.units['maxim-eraser-postgres-backup-health.service'].properties;
  service.InvocationID = 'f'.repeat(32);
  service.ExecMainStartTimestamp = 'Tue 2026-11-03 11:00:00 UTC';
  service.ExecMainExitTimestamp = 'Tue 2026-11-03 11:00:01 UTC';
  next.units['maxim-eraser-postgres-backup-health.timer'].properties.LastTriggerUSec =
    'Tue 2026-11-03 11:00:00 UTC';
  assert.deepEqual(buildBackupActivationProof(request, next), before);
});

test('busy scheduler lock refuses a second independent description', async (t) => {
  const directory = await temporary(t);
  const path = join(directory, 'lock');
  await writeFile(path, '', { mode: 0o600 });
  await withActivationSchedulerLock(path, async () => {
    await assert.rejects(
      withActivationSchedulerLock(path, async () => assert.fail('busy lock admitted')),
      /scheduler_lock_busy/u,
    );
  });
});

test('replaced scheduler lock refuses archive and preserves original owner', async (t) => {
  const directory = await temporary(t);
  const path = join(directory, 'lock');
  const replacement = join(directory, 'replacement');
  const { request, observation } = await fixture();
  const ownerPath = join(directory, 'owner');
  await writeFile(ownerPath, observation.ownerBytes, { mode: 0o600 });
  await writeFile(path, '', { mode: 0o600 });
  await writeFile(replacement, '', { mode: 0o600 });
  await withActivationSchedulerLock(path, async (assertLock) => {
    await rename(replacement, path);
    await assert.rejects(
      archiveBackupRefusal({
        ownerPath,
        archiveDirectory: join(directory, 'archive'),
        operatorUid: process.getuid(),
        operatorGid: process.getgid(),
        ownerBytes: observation.ownerBytes,
        proof: buildBackupActivationProof(request, observation),
        assertLocks: assertLock,
      }),
      /scheduler_lock_authority_lost/u,
    );
  });
  assert.deepEqual(await readFile(ownerPath), observation.ownerBytes);
});

async function ocrRestartFixture() {
  const value = await fixture();
  const item = value.observation.runtime.find((row) => row.name === '/infra-ocr-native-sandbox-1');
  Object.assign(item, {
    id: '5f69399b82fb89ef9e2eb1d7779b48128278a4edc98eb7491c1c65ea349aca4e',
    created: '2026-11-02T22:27:11.07201918Z',
    started: '2026-11-03T11:19:29.16575727Z',
    restarts: 17,
  });
  const entry =
    'apps/api/dist/apps/api/src/moderation/commercial-ocr/native-ocr-sandbox.entrypoint.js';
  value.observation.ocrRestart = {
    container: {
      id: item.id,
      created: item.created,
      image: item.image,
      restarts: item.restarts,
      command: ['node', entry],
      healthcheck: {
        Test: ['CMD', 'node', entry, '--probe'],
        Interval: 10_000_000_000,
        Timeout: 8_000_000_000,
        Retries: 3,
        StartPeriod: 20_000_000_000,
      },
      restartPolicy: 'unless-stopped',
      state: {
        Status: 'running',
        Running: true,
        Restarting: false,
        Paused: false,
        Dead: false,
        OOMKilled: false,
        StartedAt: item.started,
        Health: {
          Status: 'healthy',
          FailingStreak: 0,
          Log: [
            {
              Start: new Date(Date.now() - 2_000).toISOString(),
              End: new Date(Date.now() - 1_000).toISOString(),
              ExitCode: 0,
            },
          ],
        },
      },
    },
    logs: {
      stdout: '',
      stderr:
        '2026-11-03T11:19:29.011689382Z {"event":"native_ocr_sandbox_recycle","reason":"native_timeout","operation":"recognize","queueDepth":0,"pendingBytes":0,"requestedTimeoutMs":10000,"executionBudgetMs":9923,"queueWaitMs":0,"operationElapsedMs":9936}\n',
    },
  };
  return value;
}

test('accepts only the established OCR container after a corroborated timeout recycle and healthy restart', async () => {
  const { request, observation } = await ocrRestartFixture();
  const proof = buildBackupActivationProof(request, observation);
  assert.equal(proof.ocrRestartEvidence.containerId, observation.ocrRestart.container.id);
  assert.equal(
    proof.ocrRestartEvidence.startedAt,
    observation.ocrRestart.container.state.StartedAt,
  );
  assert.equal(proof.ocrRestartEvidence.restartCount, 17);
  assert.equal(proof.ocrRestartEvidence.recycleAt, '2026-11-03T11:19:29.011689382Z');
  assert.ok(Buffer.byteLength(JSON.stringify(proof)) < 4096);
});

for (const [name, alter] of [
  [
    'different OCR container',
    (o) => {
      o.runtime.find((r) => r.name === '/infra-ocr-native-sandbox-1').id = 'f'.repeat(64);
      o.ocrRestart.container.id = 'f'.repeat(64);
    },
  ],
  [
    'different OCR creation time',
    (o) => {
      o.runtime.find((r) => r.name === '/infra-ocr-native-sandbox-1').created =
        '2026-11-02T21:00:00Z';
      o.ocrRestart.container.created = '2026-11-02T21:00:00Z';
    },
  ],
  [
    'unadvanced OCR restart count',
    (o) => {
      o.runtime.find((r) => r.name === '/infra-ocr-native-sandbox-1').restarts = 15;
      o.ocrRestart.container.restarts = 15;
    },
  ],
  [
    'OCR inspection counter drift',
    (o) => {
      o.ocrRestart.container.restarts++;
    },
  ],
  [
    'OCR inspection start drift',
    (o) => {
      o.ocrRestart.container.state.StartedAt = '2026-11-03T11:19:30Z';
    },
  ],
  [
    'wrong OCR image',
    (o) => {
      o.runtime.find((r) => r.name === '/infra-ocr-native-sandbox-1').image =
        `sha256:${'f'.repeat(64)}`;
      o.ocrRestart.container.image = `sha256:${'f'.repeat(64)}`;
    },
  ],
  [
    'active OCR restart',
    (o) => {
      o.ocrRestart.container.state.Restarting = true;
    },
  ],
  [
    'OCR OOM marker',
    (o) => {
      o.ocrRestart.container.state.OOMKilled = true;
    },
  ],
  [
    'OCR not healthy',
    (o) => {
      o.ocrRestart.container.state.Health.Status = 'unhealthy';
    },
  ],
  [
    'missing OCR health',
    (o) => {
      delete o.ocrRestart.container.state.Health;
    },
  ],
  [
    'OCR health failure',
    (o) => {
      o.ocrRestart.container.state.Health.Log[0].ExitCode = 1;
    },
  ],
  [
    'stale OCR health',
    (o) => {
      o.ocrRestart.container.state.Health.Log[0].Start = new Date(
        Date.now() - 62_000,
      ).toISOString();
      o.ocrRestart.container.state.Health.Log[0].End = new Date(Date.now() - 61_000).toISOString();
    },
  ],
  [
    'future OCR health',
    (o) => {
      o.ocrRestart.container.state.Health.Log[0].Start = new Date(
        Date.now() + 60_000,
      ).toISOString();
      o.ocrRestart.container.state.Health.Log[0].End = new Date(Date.now() + 61_000).toISOString();
    },
  ],
  [
    'health from prior OCR process',
    (o) => {
      o.ocrRestart.container.state.Health.Log[0].Start = '2026-11-03T10:00:00Z';
      o.ocrRestart.container.state.Health.Log[0].End = '2026-11-03T10:00:01Z';
    },
  ],
  [
    'malformed OCR health clock',
    (o) => {
      o.ocrRestart.container.state.Health.Log[0].End = '2026-11-31T10:00:01Z';
    },
  ],
  [
    'wrong OCR probe command',
    (o) => {
      o.ocrRestart.container.healthcheck.Test = ['CMD', 'true'];
    },
  ],
  [
    'wrong OCR command',
    (o) => {
      o.ocrRestart.container.command = ['node', 'other.js'];
    },
  ],
  [
    'wrong OCR restart policy',
    (o) => {
      o.ocrRestart.container.restartPolicy = 'always';
    },
  ],
  [
    'missing OCR lifecycle log',
    (o) => {
      o.ocrRestart.logs.stderr = '';
    },
  ],
  [
    'different OCR recycle reason',
    (o) => {
      o.ocrRestart.logs.stderr = o.ocrRestart.logs.stderr.replace(
        'native_timeout',
        'native_output_limit',
      );
    },
  ],
  [
    'different OCR recycle operation',
    (o) => {
      o.ocrRestart.logs.stderr = o.ocrRestart.logs.stderr.replace('recognize', 'normalize');
    },
  ],
  [
    'OCR recycle outside window',
    (o) => {
      o.ocrRestart.logs.stderr = o.ocrRestart.logs.stderr.replace(
        '11:19:29.011689382Z',
        '11:19:23.011689382Z',
      );
    },
  ],
  [
    'OCR recycle after process start',
    (o) => {
      o.ocrRestart.logs.stderr = o.ocrRestart.logs.stderr.replace(
        '11:19:29.011689382Z',
        '11:19:29.165757271Z',
      );
    },
  ],
  [
    'untrusted OCR log timestamp',
    (o) => {
      o.ocrRestart.logs.stderr = o.ocrRestart.logs.stderr.slice(
        o.ocrRestart.logs.stderr.indexOf(' ') + 1,
      );
    },
  ],
  [
    'malformed OCR lifecycle JSON',
    (o) => {
      o.ocrRestart.logs.stderr = o.ocrRestart.logs.stderr.replace('"event":', '"event"=');
    },
  ],
  [
    'capped OCR logs',
    (o) => {
      o.ocrRestart.logs.stderr = o.ocrRestart.logs.stderr.repeat(32);
    },
  ],
  [
    'multiple rapid OCR recycles',
    (o) => {
      o.ocrRestart.logs.stderr = o.ocrRestart.logs.stderr.repeat(2);
    },
  ],
  [
    'future OCR start',
    (o) => {
      const start = new Date(Date.now() + 60_000).toISOString();
      o.runtime.find((r) => r.name === '/infra-ocr-native-sandbox-1').started = start;
      o.ocrRestart.container.state.StartedAt = start;
    },
  ],
])
  test(`fixed OCR exception refuses ${name}`, async () => {
    const { request, observation } = await ocrRestartFixture();
    alter(observation);
    assert.throws(() => buildBackupActivationProof(request, observation));
  });

for (const name of [
  '/infra-api-ingress-1',
  '/infra-photo-native-sandbox-1',
  '/infra-postgres-1',
  '/infra-redis-1',
])
  test(`OCR exception does not admit post-owner start for ${name}`, async () => {
    const { request, observation } = await ocrRestartFixture();
    observation.runtime.find((row) => row.name === name).started = '2026-11-03T11:00:00Z';
    assert.throws(
      () => buildBackupActivationProof(request, observation),
      /runtime_generation_changed/u,
    );
  });

test('OCR evidence requires a finite observation clock and accepts Docker stderr or stdout', async () => {
  const { request, observation } = await ocrRestartFixture();
  const item = observation.runtime.find((row) => row.name === '/infra-ocr-native-sandbox-1');
  for (const clock of [NaN, Infinity, -1, 1.5])
    assert.throws(
      () => validateActivationOcrRestart(item, observation.ocrRestart, clock),
      /invalid_observation_clock/u,
    );
  const first = buildBackupActivationProof(request, observation);
  observation.ocrRestart.logs.stdout = observation.ocrRestart.logs.stderr;
  observation.ocrRestart.logs.stderr = '';
  assert.deepEqual(buildBackupActivationProof(request, observation), first);
});

test('fresh rolling OCR probes preserve proof while a new restart requires a new preview', async () => {
  const { request, observation } = await ocrRestartFixture();
  const before = buildBackupActivationProof(request, observation);
  const refreshed = structuredClone(observation);
  refreshed.ocrRestart.container.state.Health.Log[0].Start = new Date(
    Date.now() - 900,
  ).toISOString();
  refreshed.ocrRestart.container.state.Health.Log[0].End = new Date(Date.now() - 500).toISOString();
  assert.deepEqual(buildBackupActivationProof(request, refreshed), before);
  const preview = await recoverBackupActivation(request, { observe: async () => observation });
  let count = 0;
  let archived = false;
  await assert.rejects(
    recoverBackupActivation(
      { ...request, mode: 'apply', proofSha256: preview.proofSha256 },
      {
        observe: async () => {
          const value = structuredClone(observation);
          if (++count > 1) {
            value.runtime.find((row) => row.name === '/infra-ocr-native-sandbox-1').restarts++;
            value.ocrRestart.container.restarts++;
          }
          return value;
        },
        archive: async () => {
          archived = true;
        },
      },
    ),
    /recovery_evidence_changed/u,
  );
  assert.equal(archived, false);
});

test('OCR collector actually captures bounded container stderr without invoking mutators', async (t) => {
  const directory = await temporary(t);
  const { request, observation } = await ocrRestartFixture();
  const evidence = observation.ocrRestart;
  const fakeDocker = `#!${process.execPath}
const args=process.argv.slice(2);
if(args[0]==='inspect' && args.at(-1)===${JSON.stringify(evidence.container.id)}) process.stdout.write(${JSON.stringify(JSON.stringify(evidence.container))});
else if(args[0]==='logs' && args.at(-1)===${JSON.stringify(evidence.container.id)} && args.includes('--timestamps') && args[args.indexOf('--tail')+1]==='32' && args[args.indexOf('--until')+1]===${JSON.stringify(evidence.container.state.StartedAt)}) process.stderr.write(${JSON.stringify(evidence.logs.stderr)});
else process.exitCode=99;
`;
  await writeFile(join(directory, 'docker'), fakeDocker, { mode: 0o700 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${directory}:${oldPath}`;
  try {
    observation.ocrRestart = await observeActivationOcrRestart(
      observation.runtime.find((row) => row.name === '/infra-ocr-native-sandbox-1'),
    );
    assert.equal(observation.ocrRestart.logs.stdout, '');
    assert.equal(observation.ocrRestart.logs.stderr, evidence.logs.stderr);
    assert.equal(
      buildBackupActivationProof(request, observation).ocrRestartEvidence.restartCount,
      17,
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

// Sanitized verbatim systemctl representation: two records, including its spaces
// before separators. No owner token, invocation identity or private export is embedded.
const eraserPrecheckRecords = [
  'ExecStartPre={ path=/usr/bin/test ; argv[]=/usr/bin/test -f /var/www/Chat_bot/infra/scripts/lib/postgres-backup-profile.sh ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }',
  'ExecStartPre={ path=/usr/bin/env ; argv[]=/usr/bin/env MAXIM_BACKUP_PROFILE=eraser node /var/www/Chat_bot/infra/scripts/postgres-backup-schedule.mjs capability ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }',
];

const emptyCommandKeys = ['ExecCondition', 'ExecStartPost', 'ExecStop', 'ExecStopPost'];
async function withUnitCollector(t, name, raw, options, inspect) {
  const directory = await temporary(t);
  const missing = options.missing ?? emptyCommandKeys;
  const callsPath = join(directory, 'calls.jsonl');
  const actualPython = spawnSync(
    'python3',
    ['-I', '-B', '-c', 'import sys; print(sys.executable)'],
    { encoding: 'utf8' },
  );
  assert.equal(actualPython.status, 0);
  const systemctl = `#!${process.execPath}\nconst args=process.argv.slice(2); if(args[0]!=='show'||args[1]!==${JSON.stringify(name)}||!args.includes('--all')||!args.includes('--property=ExecStartPre')||!args.includes('--property=NeedDaemonReload')) process.exit(99); process.stdout.write(${JSON.stringify(raw)});\n`;
  // Run the actual embedded Python body with a typed fake D-Bus module. This checks
  // isolation/arguments, same-connection lifetime, typed values and cleanup failures.
  const fakeDbus = `
import json, sys, types
scenario = ${JSON.stringify(options.scenario ?? '')}
calls_path = ${JSON.stringify(callsPath)}
expected_unit = ${JSON.stringify(name)}
expected_keys = ${JSON.stringify(missing)}
def record(method):
    with open(calls_path, 'a') as stream: stream.write(json.dumps(method) + '\\n')
class ObjectPath(str): pass
class Array(list):
    def __init__(self, values=(), signature='(sasbttttuii)'):
        super().__init__(values)
        self.signature = signature
class Bus:
    def __init__(self, address):
        assert address == 'unix:path=/run/dbus/system_bus_socket'
        self.held = False
    def get_object(self, destination, path, introspect):
        assert destination == 'org.freedesktop.systemd1' and introspect is False
        return self
    def RefUnit(self, unit, timeout):
        assert unit == expected_unit and timeout == 1 and not self.held
        record('ref')
        if scenario == 'ref_failure': raise RuntimeError('ref_failed')
        self.held = True
    def GetUnit(self, unit, timeout):
        assert unit == expected_unit and timeout == 1 and self.held
        record('path')
        if scenario == 'lookup_failure': raise RuntimeError('lookup_failed')
        path = '/org/freedesktop/systemd1/unit/' + unit.replace('-', '_2d').replace('.', '_2e')
        if scenario == 'wrong_path': path += '_unrelated'
        return str(path) if scenario == 'wrong_path_type' else ObjectPath(path)
    def Get(self, interface, key, timeout):
        assert interface == 'org.freedesktop.systemd1.Service' and key in expected_keys and timeout == 1 and self.held
        record(key)
        if scenario == 'property_failure': raise RuntimeError('property_failed')
        if scenario == 'plain_list': return []
        return Array(['/bin/true'] if scenario == 'nonempty' else [], 's' if scenario == 'wrong_signature' else '(sasbttttuii)')
    def UnrefUnit(self, unit, timeout):
        assert unit == expected_unit and timeout == 1 and self.held
        record('unref')
        if scenario == 'unref_failure': raise RuntimeError('unref_failed')
        self.held = False
    def close(self):
        record('close')
        if scenario == 'close_failure': raise RuntimeError('close_failed')
def interface(obj, name):
    assert name in ['org.freedesktop.systemd1.Manager', 'org.freedesktop.DBus.Properties']
    return obj
sys.modules['dbus'] = types.SimpleNamespace(bus=types.SimpleNamespace(BusConnection=Bus), Interface=interface, String=str, ObjectPath=ObjectPath, Array=Array)
`;
  const python = `#!${process.execPath}
const fs=require('node:fs');const {spawnSync}=require('node:child_process');const args=process.argv.slice(2);
if(JSON.stringify(args.slice(0,3))!==JSON.stringify(['-I','-B','-c'])||JSON.stringify(args.slice(4))!==${JSON.stringify(JSON.stringify([name, ...missing]))}) process.exit(99);
const result=spawnSync(${JSON.stringify(actualPython.stdout.trim())},['-I','-B','-c',${JSON.stringify(fakeDbus)}+args[3],...args.slice(4)],{encoding:'utf8'});
process.stdout.write(${options.reply === undefined ? 'result.stdout' : JSON.stringify(options.reply)});process.stderr.write(result.stderr);process.exitCode=result.status ?? 99;
`;
  await writeFile(join(directory, 'systemctl'), systemctl, { mode: 0o700 });
  await writeFile(join(directory, 'python3'), python, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${directory}:${previousPath}`;
  try {
    await inspect(
      async () => observeActivationUnitProperties(name),
      async () => {
        try {
          return (await readFile(callsPath, 'utf8'))
            .trimEnd()
            .split('\n')
            .map((line) => JSON.parse(line));
        } catch (error) {
          if (error.code === 'ENOENT') return [];
          throw error;
        }
      },
    );
  } finally {
    process.env.PATH = previousPath;
  }
}

test('actual collector preserves repeated Eraser prechecks and proves omitted command vectors through typed D-Bus', async (t) => {
  const { request, observation } = await fixture();
  const name = 'maxim-eraser-postgres-backup.service';
  const raw =
    Object.entries(observation.units[name].properties)
      .flatMap(([key, value]) =>
        key === 'ExecStartPre' ? eraserPrecheckRecords : [`${key}=${value}`],
      )
      .join('\n') + '\n';
  const omittedEmptyCommands = raw.replace(/^Exec(?:Condition|StartPost|Stop|StopPost)=\n/gmu, '');
  await withUnitCollector(t, name, omittedEmptyCommands, {}, async (collect, calls) => {
    observation.units[name].properties = await collect();
    assert.equal(
      observation.units[name].properties.ExecStartPre,
      eraserPrecheckRecords.map((line) => line.slice('ExecStartPre='.length)).join(' '),
    );
    for (const key of emptyCommandKeys) assert.equal(observation.units[name].properties[key], '');
    assert.deepEqual(await calls(), ['ref', 'path', ...emptyCommandKeys, 'unref', 'close']);
    assert.doesNotThrow(() => buildBackupActivationProof(request, observation));
  });
});

for (const [name, scenario] of [
  ['wrong unit path', 'wrong_path'],
  ['untyped unit path', 'wrong_path_type'],
  ['GetUnit failure', 'lookup_failure'],
  ['RefUnit failure', 'ref_failure'],
  ['wrong command signature', 'wrong_signature'],
  ['nonempty command vector', 'nonempty'],
  ['untyped command vector', 'plain_list'],
  ['property read failure', 'property_failure'],
  ['reference release failure', 'unref_failure'],
  ['connection close failure', 'close_failure'],
]) {
  test(`actual typed collector refuses ${name} and closes its connection`, async (t) => {
    const unit = 'maxim-eraser-postgres-backup.service';
    await withUnitCollector(t, unit, `Id=${unit}\n`, { scenario }, async (collect, calls) => {
      await assert.rejects(collect, /bounded_observation_failed/u);
      const observed = await calls();
      assert.equal(observed[0], 'ref');
      assert.equal(observed.at(-1), 'close');
      assert.equal(observed.includes('unref'), scenario !== 'ref_failure');
    });
  });
}

for (const [name, mutate] of [
  [
    'wrong unit',
    (value) => {
      value.unit = 'unrelated.service';
    },
  ],
  [
    'wrong path',
    (value) => {
      value.objectPath = '/unrelated';
    },
  ],
  [
    'unreleased reference',
    (value) => {
      value.referenceReleased = false;
    },
  ],
  [
    'missing vector',
    (value) => {
      value.properties.pop();
    },
  ],
  [
    'extra vector',
    (value) => {
      value.properties.push(value.properties[0]);
    },
  ],
  [
    'reordered vectors',
    (value) => {
      value.properties.reverse();
    },
  ],
  [
    'unknown vector',
    (value) => {
      value.properties[0].name = 'Unknown';
    },
  ],
  [
    'wrong signature',
    (value) => {
      value.properties[0].type = 'as';
    },
  ],
  [
    'nonzero count',
    (value) => {
      value.properties[0].count = 1;
    },
  ],
  [
    'extra evidence key',
    (value) => {
      value.extra = true;
    },
  ],
  [
    'extra vector key',
    (value) => {
      value.properties[0].extra = true;
    },
  ],
]) {
  test(`typed collector reply refuses ${name}`, async (t) => {
    const unit = 'maxim-eraser-postgres-backup.service';
    const evidence = {
      unit,
      objectPath: '/org/freedesktop/systemd1/unit/maxim_2deraser_2dpostgres_2dbackup_2eservice',
      properties: emptyCommandKeys.map((name) => ({ name, type: 'a(sasbttttuii)', count: 0 })),
      referenceReleased: true,
    };
    mutate(evidence);
    await withUnitCollector(
      t,
      unit,
      `Id=${unit}\n`,
      { reply: JSON.stringify(evidence) },
      async (collect) => {
        await assert.rejects(collect, /empty_service_commands_unproved/u);
      },
    );
  });
}

test('typed fallback queries only missing hooks and never overwrites an observed nonempty hook', async (t) => {
  const { request, observation } = await fixture();
  const name = 'maxim-postgres-backup.service';
  const p = observation.units[name].properties;
  p.ExecStop = argv('/bin/true');
  const raw =
    Object.entries(p)
      .filter(([key]) => key !== 'ExecCondition')
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n';
  await withUnitCollector(t, name, raw, { missing: ['ExecCondition'] }, async (collect) => {
    observation.units[name].properties = await collect();
    assert.equal(observation.units[name].properties.ExecCondition, '');
    assert.equal(observation.units[name].properties.ExecStop, p.ExecStop);
    assert.throws(
      () => buildBackupActivationProof(request, observation),
      /service_execution_boundary_changed/u,
    );
  });
});

for (const name of ['maxim-postgres-backup.service', 'maxim-postgres-backup.timer'])
  test(`complete ${name} observation does not query D-Bus`, async (t) => {
    const units = await unitsFixture();
    const raw =
      Object.entries(units[name].properties)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') + '\n';
    await withUnitCollector(t, name, raw, { scenario: 'ref_failure' }, async (collect, calls) => {
      assert.deepEqual(await collect(), units[name].properties);
      assert.deepEqual(await calls(), []);
    });
  });

test('unknown unit is refused before any collector command', async (t) => {
  await withUnitCollector(
    t,
    'unrelated.service',
    'Id=unrelated.service\n',
    {},
    async (collect, calls) => {
      await assert.rejects(collect, /unknown_backup_unit/u);
      assert.deepEqual(await calls(), []);
    },
  );
});

for (const [name, raw] of [
  ['duplicate scalar', 'Id=one\nId=one\n'],
  ['duplicate ExecStart', 'ExecStart=one\nExecStart=two\n'],
  ['unknown property', 'Unexpected=value\n'],
  ['extra precheck', eraserPrecheckRecords.concat(eraserPrecheckRecords[0]).join('\n') + '\n'],
  ['empty repeated precheck', eraserPrecheckRecords[0] + '\nExecStartPre=\n'],
  ['empty leading precheck', 'ExecStartPre=\n' + eraserPrecheckRecords[0] + '\n'],
  ['blank interior line', 'Id=one\n\nLoadState=loaded\n'],
  ['extra trailing newline', 'Id=one\n\n'],
  ['missing newline', 'Id=one'],
  ['carriage return', 'Id=one\r\n'],
  ['NUL byte', 'Id=one\0\n'],
  ['continuation line', 'Id=one\n malformed continuation\n'],
  ['oversized value', 'Id=' + 'a'.repeat(65_536) + '\n'],
])
  test(`systemctl parser refuses ${name}`, () => {
    assert.throws(() => parseActivationUnitProperties(raw), /invalid_unit_observation/u);
  });

test('single precheck and empty scalar retain their exact property values', () => {
  const line = eraserPrecheckRecords[1];
  assert.deepEqual(parseActivationUnitProperties(`User=\n${line}\n`), {
    User: '',
    ExecStartPre: line.slice('ExecStartPre='.length),
  });
});

for (const [name, records] of [
  ['reversed', [...eraserPrecheckRecords].reverse()],
  ['duplicated', [eraserPrecheckRecords[0], eraserPrecheckRecords[0]]],
  [
    'additional loaded command',
    [
      eraserPrecheckRecords[0],
      eraserPrecheckRecords[1] + ' { path=/bin/true ; argv[]=/bin/true ; ignore_errors=no ; }',
    ],
  ],
])
  test(`preserved ${name} Eraser prechecks still fail exact command validation`, async () => {
    const { request, observation } = await fixture();
    const name = 'maxim-eraser-postgres-backup.service';
    const raw =
      Object.entries(observation.units[name].properties)
        .flatMap(([key, value]) => (key === 'ExecStartPre' ? records : [`${key}=${value}`]))
        .join('\n') + '\n';
    observation.units[name].properties = parseActivationUnitProperties(raw);
    assert.throws(
      () => buildBackupActivationProof(request, observation),
      /service_command_changed/u,
    );
  });

test('activation source Git reads preserve the index despite stale file stats and inherited optional locks', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maxim-activation-git-read-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', ['-C', directory, ...args], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git('init', '--quiet');
  const tracked = join(directory, 'tracked.txt');
  await writeFile(tracked, 'committed content\n');
  git('add', 'tracked.txt');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'source',
  );
  const current = await lstat(tracked);
  const changedTime = new Date(current.mtimeMs + 10_000);
  await utimes(tracked, changedTime, changedTime);
  const index = join(directory, '.git/index');
  const identity = async () => {
    const metadata = await lstat(index, { bigint: true });
    return {
      ...Object.fromEntries(
        ['dev', 'ino', 'uid', 'gid', 'mode', 'size', 'mtimeNs', 'ctimeNs'].map((key) => [
          key,
          metadata[key],
        ]),
      ),
      bytes: digest(await readFile(index)),
    };
  };
  const before = await identity();
  const inherited = process.env.GIT_OPTIONAL_LOCKS;
  const mask = process.umask(0o077);
  process.env.GIT_OPTIONAL_LOCKS = '1';
  try {
    assert.equal(await observeActivationSourceGit(directory, ['status', '--porcelain']), '');
    assert.deepEqual(await identity(), before);
    await writeFile(tracked, 'changed content\n');
    await writeFile(join(directory, 'untracked.txt'), 'new file\n');
    const status = await observeActivationSourceGit(directory, ['status', '--porcelain']);
    assert.match(status, /^ M tracked\.txt$/mu);
    assert.match(status, /^\?\? untracked\.txt$/mu);
    assert.deepEqual(await identity(), before);
  } finally {
    process.umask(mask);
    if (inherited === undefined) delete process.env.GIT_OPTIONAL_LOCKS;
    else process.env.GIT_OPTIONAL_LOCKS = inherited;
  }
});
