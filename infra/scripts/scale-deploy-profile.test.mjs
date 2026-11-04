import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  SCALE_MACHINE_ID,
  SCALE_PUBLIC_ORIGIN,
  scaleDeployFixture,
} from './test-fixtures/scale-deploy-profile.mjs';

function assertRefused(result, calls) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2, result.stderr);
  assert.doesNotMatch(calls, /ssh-remote|lock-acquired|authority-checked|prohibited|git-fixture/u);
}

test('scale connector refuses the default production profile before SSH even with opt-in', () => {
  const state = scaleDeployFixture();
  try {
    const result = state.run('vps-connect.sh', ['deploy-scale', 'main']);
    assert.equal(result.error, undefined);
    assert.deepEqual(
      { status: result.status, calls: state.calls() },
      { status: 2, calls: '' },
      result.stderr,
    );
  } finally {
    state.cleanup();
  }
});

test('scale server refuses a missing isolation profile before acquiring the lock even with opt-in', () => {
  const state = scaleDeployFixture({ server: true });
  try {
    const result = state.run('vps-pull-build-up-scale.sh', ['main']);
    assert.equal(result.error, undefined);
    assert.deepEqual(
      { status: result.status, calls: state.calls() },
      { status: 2, calls: '' },
      result.stderr,
    );
  } finally {
    state.cleanup();
  }
});

for (const [label, patch] of [
  ['unknown purpose', { MAXIM_SCALE_DEPLOY_PROFILE: 'production' }],
  ['missing purpose', { MAXIM_SCALE_DEPLOY_PROFILE: undefined }],
  ['missing machine identity', { MAXIM_SCALE_EXPECTED_MACHINE_ID: undefined }],
  ['malformed machine identity', { MAXIM_SCALE_EXPECTED_MACHINE_ID: 'not-an-identity' }],
  ['missing explicit target', { MAXIM_VPS_SSH_TARGET: undefined }],
  ['missing explicit repo', { MAXIM_VPS_REPO_DIR: undefined }],
  ['missing explicit origin', { MAXIM_VPS_PUBLIC_URL: undefined }],
  ['production alias', { MAXIM_VPS_SSH_TARGET: 'maxim-vps' }],
  ['production alias with case and trailing dot', { MAXIM_VPS_SSH_TARGET: 'MAXIM-VPS.' }],
  ['production address with user', { MAXIM_VPS_SSH_TARGET: 'maximadmin@89.108.122.76' }],
  ['retired alias', { MAXIM_VPS_SSH_TARGET: 'maxim-vps-yandex-retired' }],
  ['production repo', { MAXIM_VPS_REPO_DIR: '/var/www/Chat_bot' }],
  ['production descendant repo', { MAXIM_VPS_REPO_DIR: '/var/www/Chat_bot/other' }],
  ['Svyazka repo', { MAXIM_VPS_REPO_DIR: '/var/www/svyazka' }],
  ['Karavan repo', { MAXIM_VPS_REPO_DIR: '/var/www/max-delivery-platform' }],
  ['noncanonical repo', { MAXIM_VPS_REPO_DIR: '/srv/test/../maxim' }],
  ['production origin', { MAXIM_VPS_PUBLIC_URL: 'https://major-maksimov.ru' }],
  ['production admin origin', { MAXIM_VPS_PUBLIC_URL: 'https://admin.major-maksimov.ru' }],
  ['legacy production origin', { MAXIM_VPS_PUBLIC_URL: 'https://maxim.play-team.ru' }],
  ['origin with credentials', { MAXIM_VPS_PUBLIC_URL: 'https://user:password@loadtest.invalid' }],
  ['origin with a path', { MAXIM_VPS_PUBLIC_URL: 'https://loadtest.invalid/app/' }],
  ['origin with port zero', { MAXIM_VPS_PUBLIC_URL: 'https://loadtest.invalid:0' }],
  ['origin with oversized port', { MAXIM_VPS_PUBLIC_URL: 'https://loadtest.invalid:65536' }],
]) {
  test(`scale connector refuses ${label} before remote execution`, () => {
    const state = scaleDeployFixture();
    try {
      state.writeProfile(patch);
      const result = state.run('vps-connect.sh', ['deploy-scale', 'main'], {
        MAXIM_VPS_ENV_FILE: state.profile,
      });
      assertRefused(result, state.calls());
    } finally {
      state.cleanup();
    }
  });
}

test('scale connector refuses a missing separate file and a symlink to ordinary config', () => {
  const state = scaleDeployFixture();
  try {
    const missing = join(state.directory, 'absent.env');
    assertRefused(
      state.run('vps-connect.sh', ['deploy-scale', 'main'], { MAXIM_VPS_ENV_FILE: missing }),
      state.calls(),
    );
    symlinkSync(join(state.directory, '.env.vps'), state.profile);
    assertRefused(
      state.run('vps-connect.sh', ['deploy-scale', 'main'], { MAXIM_VPS_ENV_FILE: state.profile }),
      state.calls(),
    );
  } finally {
    state.cleanup();
  }
});

test('scale connector rejects a production effective SSH hostname under another alias', () => {
  const state = scaleDeployFixture();
  try {
    state.writeProfile();
    const result = state.run('vps-connect.sh', ['deploy-scale', 'main'], {
      MAXIM_VPS_ENV_FILE: state.profile,
      SCALE_TEST_EFFECTIVE_HOST: '89.108.122.76',
    });
    assertRefused(result, state.calls());
    assert.equal(state.calls(), 'ssh-config\n');
  } finally {
    state.cleanup();
  }
});

for (const extraArgs of ['-- maxim-vps', 'maxim-vps', '-o BatchMode=yes']) {
  test(`scale connector refuses nonempty SSH extra args ${JSON.stringify(extraArgs)} before SSH config`, () => {
    const state = scaleDeployFixture();
    try {
      state.writeProfile({ MAXIM_VPS_SSH_EXTRA_ARGS: extraArgs });
      const result = state.run('vps-connect.sh', ['deploy-scale', 'main'], {
        MAXIM_VPS_ENV_FILE: state.profile,
      });
      assert.equal(result.error, undefined);
      assert.deepEqual(
        { status: result.status, calls: state.calls() },
        { status: 2, calls: '' },
        result.stderr,
      );
    } finally {
      state.cleanup();
    }
  });
}

test('scale connector forwards only the explicit isolated profile in one mocked SSH invocation', () => {
  const state = scaleDeployFixture();
  try {
    state.writeProfile({
      MAXIM_SCALE_EXPECTED_REPO_DIR: '/caller-forged-repo',
      MAXIM_VPS_AUTO_AUTHORIZE_SSH: '1',
      MAXIM_VPS_SSH_PORT: '2222',
      MAXIM_VPS_SSH_KEY: '/isolated/loadtest-key',
      MAXIM_VPS_SSH_CONFIG: '/isolated/loadtest-ssh-config',
    });
    const result = state.run('vps-connect.sh', ['deploy-scale', 'main', 'miniapp-major-static'], {
      MAXIM_VPS_ENV_FILE: state.profile,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 97, result.stderr);
    assert.equal(state.calls(), 'ssh-config\nssh-remote\n');
    const args = state.sshArguments();
    for (const [option, value] of [
      ['-p', '2222'],
      ['-i', '/isolated/loadtest-key'],
      ['-F', '/isolated/loadtest-ssh-config'],
    ])
      assert.equal(args[args.indexOf(option) + 1], value);
    assert.equal(args.at(-2), 'scale-test');
    const command = args.at(-1);
    for (const expected of [
      'MAXIM_ALLOW_SCALE_DEPLOY=1',
      'MAXIM_SCALE_DEPLOY_PROFILE=isolated-loadtest-v1',
      `MAXIM_SCALE_EXPECTED_MACHINE_ID=${SCALE_MACHINE_ID}`,
      `MAXIM_SCALE_EXPECTED_REPO_DIR=${state.directory}`,
      `MAXIM_VPS_PUBLIC_URL=${SCALE_PUBLIC_ORIGIN}`,
      './infra/scripts/vps-pull-build-up-scale.sh',
      'miniapp-major-static',
    ])
      assert.ok(command.includes(expected), `missing forwarded value: ${expected}`);
    assert.equal(command.includes('/caller-forged-repo'), false);
  } finally {
    state.cleanup();
  }
});

test('untrusted scale target and repo text cannot execute a local command', () => {
  const state = scaleDeployFixture();
  try {
    const marker = join(state.directory, 'injected');
    for (const patch of [
      { MAXIM_VPS_SSH_TARGET: `scale; touch ${marker}` },
      { MAXIM_VPS_REPO_DIR: `/srv/$(touch ${marker})` },
    ]) {
      state.writeProfile(patch);
      assertRefused(
        state.run('vps-connect.sh', ['deploy-scale', 'main'], {
          MAXIM_VPS_ENV_FILE: state.profile,
        }),
        state.calls(),
      );
      assert.equal(existsSync(marker), false);
    }
  } finally {
    state.cleanup();
  }
});

test('ordinary connector commands retain production configuration without a scale profile', () => {
  const state = scaleDeployFixture();
  try {
    const result = state.run('vps-connect.sh', ['health']);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 97, result.stderr);
    assert.equal(state.calls(), 'ssh-remote\n');
    assert.equal(state.sshArguments().at(-2), 'maxim-vps');
  } finally {
    state.cleanup();
  }
});

for (const [label, patch] of [
  ['unknown purpose', { MAXIM_SCALE_DEPLOY_PROFILE: 'production' }],
  ['missing expected identity', { MAXIM_SCALE_EXPECTED_MACHINE_ID: undefined }],
  ['mismatched expected identity', { MAXIM_SCALE_EXPECTED_MACHINE_ID: 'b'.repeat(32) }],
  ['missing expected repo', { MAXIM_SCALE_EXPECTED_REPO_DIR: undefined }],
  ['mismatched expected repo', { MAXIM_SCALE_EXPECTED_REPO_DIR: '/srv/another-loadtest' }],
  ['missing explicit origin', { MAXIM_VPS_PUBLIC_URL: undefined }],
  ['production origin', { MAXIM_VPS_PUBLIC_URL: 'https://major-maksimov.ru' }],
  ['production actual address', { SCALE_TEST_HOST_ADDRESSES: '192.0.2.40 89.108.122.76' }],
  ['missing actual addresses', { SCALE_TEST_HOST_ADDRESSES: '' }],
  ['failed actual-address observation', { SCALE_TEST_HOST_READ_FAIL: '1' }],
  ['production SSH server endpoint', { SSH_CONNECTION: '198.51.100.10 12345 89.108.122.76 22' }],
  ['malformed SSH server evidence', { SSH_CONNECTION: 'not-an-SSH-connection' }],
  ['a remote Docker host', { DOCKER_HOST: 'ssh://maximadmin@89.108.122.76' }],
  ['an explicit Docker context', { DOCKER_CONTEXT: 'production' }],
  ['a persisted remote Docker context', { SCALE_TEST_DOCKER_CONTEXT: 'production' }],
  ['missing effective Docker context', { SCALE_TEST_DOCKER_CONTEXT: '' }],
  ['a remote default Docker endpoint', { SCALE_TEST_DOCKER_ENDPOINT: 'tcp://89.108.122.76:2375' }],
  ['missing default Docker endpoint', { SCALE_TEST_DOCKER_ENDPOINT: '' }],
]) {
  test(`scale server refuses ${label} before lock and Git`, () => {
    const state = scaleDeployFixture({ server: true });
    try {
      state.admitServer();
      assertRefused(state.run('vps-pull-build-up-scale.sh', ['main'], patch), state.calls());
    } finally {
      state.cleanup();
    }
  });
}

for (const kind of [
  'missing-machine',
  'malformed-machine',
  'production-directory',
  'production-symlink',
  'repo-symlink',
]) {
  test(`scale server independently refuses ${kind} in its copied host fixture`, () => {
    const state = scaleDeployFixture({ server: true });
    try {
      const identity = state.admitServer();
      const extra = {};
      if (kind === 'missing-machine') rmSync(identity.machine);
      else if (kind === 'malformed-machine') writeFileSync(identity.machine, 'not-a-machine\n');
      else if (kind === 'production-directory') mkdirSync(identity.production);
      else if (kind === 'production-symlink')
        symlinkSync('absent-production-checkout', identity.production);
      else {
        const alias = join(state.directory, 'repo-alias');
        symlinkSync(state.directory, alias);
        extra.MAXIM_SCALE_EXPECTED_REPO_DIR = alias;
      }
      assertRefused(state.run('vps-pull-build-up-scale.sh', ['main'], extra), state.calls());
    } finally {
      state.cleanup();
    }
  });
}

test('scale refuses a forged continuation SHA without an inherited lock before lock or sync', () => {
  const state = scaleDeployFixture({ server: true });
  try {
    state.admitServer();
    const result = state.run('vps-pull-build-up-scale.sh', ['main'], {
      MAXIM_SCALE_REEXEC_TARGET_SHA: '2'.padStart(40, '0'),
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(state.calls(), 'host-read\ndocker-context-show\ndocker-context-inspect\n');
  } finally {
    state.cleanup();
  }
});

for (const origin of [SCALE_PUBLIC_ORIGIN, 'http://loadtest.example.invalid:8080']) {
  test(`an independently admitted scale host still stops at cold authority with ${origin}`, () => {
    const state = scaleDeployFixture({ server: true });
    try {
      state.admitServer();
      const result = state.run('vps-pull-build-up-scale.sh', ['main'], {
        MAXIM_VPS_PUBLIC_URL: origin,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 73, result.stderr);
      assert.match(result.stderr, /cold fixture authority refused/u);
      assert.equal(
        state.calls(),
        'host-read\ndocker-context-show\ndocker-context-inspect\nlock-acquired\nauthority-checked\nlock-released\n',
      );
    } finally {
      state.cleanup();
    }
  });
}

for (const reexec of [false, true]) {
  test(`scale ${reexec ? 'reexec' : 'post-sync'} revalidates host identity before later effects`, () => {
    const state = scaleDeployFixture({ server: true });
    try {
      const identity = state.admitServer();
      state.syncThenInvalidate(identity, { reexec });
      const result = state.run('vps-pull-build-up-scale.sh', ['main']);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 2, result.stderr);
      const calls = state.calls();
      assert.match(calls, /lock-acquired\nauthority-checked\ngit-fixture:fetch origin main/u);
      assert.match(calls, /git-fixture:merge --ff-only 0000000000000000000000000000000000000002/u);
      assert.doesNotMatch(calls, /prohibited|ssh-remote/u);
      assert.equal((calls.match(/authority-checked/gu) ?? []).length, 1);
      assert.doesNotMatch(result.stdout, /Re-executing updated/u);
    } finally {
      state.cleanup();
    }
  });
}

for (const reexec of [false, true]) {
  for (const mutation of ['legacy-entrypoint', 'missing-helper']) {
    test(`scale ${reexec ? 'reexec' : 'post-sync'} refuses ${mutation} before executing synchronized source`, () => {
      const state = scaleDeployFixture({ server: true });
      try {
        state.admitServer();
        state.syncThenRemoveAdmission({ reexec, mutation });
        const result = state.run('vps-pull-build-up-scale.sh', ['main']);
        assert.equal(result.error, undefined);
        const calls = state.calls();
        assert.deepEqual(
          {
            status: result.status,
            prohibitedCalls: calls.match(/(?:legacy-effect|[^\n]*prohibited)[^\n]*/gu) ?? [],
          },
          { status: 2, prohibitedCalls: [] },
          `${result.stderr}\nObserved calls:\n${calls}`,
        );
        assert.match(calls, /lock-acquired\nauthority-checked\ngit-fixture:fetch origin main/u);
        assert.match(
          calls,
          /git-fixture:merge --ff-only 0000000000000000000000000000000000000002/u,
        );
        assert.equal((calls.match(/authority-checked/gu) ?? []).length, 1);
        assert.doesNotMatch(result.stdout, /Re-executing updated/u);
      } finally {
        state.cleanup();
      }
    });
  }
}

for (const mutationPhase of ['remote', 'local']) {
  for (const mutation of ['legacy-entrypoint', 'missing-helper']) {
    test(`scale refuses ${mutationPhase} ${mutation} before checking out unadmitted source`, () => {
      const state = scaleDeployFixture({ server: true });
      try {
        state.admitServer();
        state.syncThenRemoveAdmission({ mutation, mutationPhase, reexec: true });
        const result = state.run('vps-pull-build-up-scale.sh', ['main']);
        assert.equal(result.error, undefined);
        assert.equal(result.status, 2, `${result.stderr}\n${state.calls()}`);
        assert.match(state.calls(), /git-fixture:fetch origin main/u);
        assert.doesNotMatch(
          state.calls(),
          /git-fixture:checkout|git-fixture:merge|legacy-effect|prohibited/u,
        );
        assert.equal((state.calls().match(/authority-checked/gu) ?? []).length, 1);
      } finally {
        state.cleanup();
      }
    });
  }
}

for (const inheritedReexecMarker of [false, true]) {
  test(`a compatible scale byte-offset update reexecutes into cold authority73 with caller reexec marker ${inheritedReexecMarker}`, () => {
    const state = scaleDeployFixture({ server: true });
    try {
      state.admitServer();
      state.syncThenUpdateEntrypoint();
      const script = join(state.directory, 'infra/scripts/vps-pull-build-up-scale.sh');
      const originalLength = readFileSync(script).length;
      const result = state.run('vps-pull-build-up-scale.sh', ['main'], {
        ...(inheritedReexecMarker ? { MAXIM_DEPLOY_SCRIPT_REEXECED: '1' } : {}),
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 73, `${result.stderr}\n${state.calls()}`);
      assert.ok(readFileSync(script).length > originalLength);
      assert.match(result.stderr, /cold fixture authority refused/u);
      assert.match(result.stdout, /Re-executing updated/u);
      const calls = state.calls();
      assert.match(calls, /git-fixture:merge --ff-only 0000000000000000000000000000000000000002/u);
      assert.equal((calls.match(/authority-checked/gu) ?? []).length, 3);
      assert.equal((calls.match(/git-fixture:fetch origin main/gu) ?? []).length, 1);
      assert.equal((calls.match(/git-fixture:merge --ff-only/gu) ?? []).length, 1);
      const carriedContinuation = calls.split('authority-checked\n')[2];
      assert.ok(
        carriedContinuation.includes(
          'git-fixture:rev-parse --verify --end-of-options HEAD^{commit}',
        ),
      );
      assert.ok(
        carriedContinuation.includes(
          'git-fixture:show 0000000000000000000000000000000000000002:infra/scripts/lib/scale-deploy-profile.sh',
        ),
      );
      assert.doesNotMatch(calls, /legacy-effect|prohibited|ssh-remote/u);
      assert.equal(calls.endsWith('lock-released\n'), true);
    } finally {
      state.cleanup();
    }
  });
}

for (const mutation of ['head-drift', 'disk-only-noncritical']) {
  test(`scale refuses post-merge ${mutation} before reexec or later effects`, () => {
    const state = scaleDeployFixture({ server: true });
    try {
      state.admitServer();
      state.syncThenRemoveAdmission({ mutation, reexec: true });
      const result = state.run('vps-pull-build-up-scale.sh', ['main']);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 2, `${result.stderr}\n${state.calls()}`);
      assert.match(
        state.calls(),
        /git-fixture:merge --ff-only 0000000000000000000000000000000000000002/u,
      );
      assert.equal((state.calls().match(/authority-checked/gu) ?? []).length, 1);
      assert.doesNotMatch(state.calls(), /legacy-effect|prohibited|ssh-remote/u);
      assert.doesNotMatch(result.stdout, /Re-executing updated/u);
    } finally {
      state.cleanup();
    }
  });
}
