import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, writeFile, lstat, rm, access, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ACTIVATION,
  parseBackupActivationRecoveryArgs,
  buildBackupActivationProof,
  recoverBackupActivation,
  withActivationSchedulerLock,
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
