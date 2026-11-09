import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { deployLockFixture, deployLockEnvironment } from './test-fixtures/deploy-lock.mjs';

const wrappers = [
  {
    name: 'legacy',
    wrapper: 'vps-legacy-cold-recovery.sh',
    host: 'legacy-cold-host.mjs',
    sourceEnv: 'MAXIM_EXPECTED_DEPLOY_SHA',
    args: [],
  },
  {
    name: 'source',
    wrapper: 'vps-source-abandonment.sh',
    host: 'source-abandonment-host.mjs',
    sourceEnv: 'MAXIM_EXPECTED_DEPLOY_SHA',
    args: [],
    hostArgs: ['--supervised-preflight'],
  },
  {
    name: 'corrective',
    wrapper: 'vps-source-abandonment-corrective.sh',
    host: 'source-abandonment-corrective-host.mjs',
    sourceEnv: 'MAXIM_EXPECTED_CONTROLLER_SHA',
    args: [],
  },
  {
    name: 'backlog',
    wrapper: 'vps-backlog-cancellation.sh',
    host: 'backlog-cancellation-host.mjs',
    sourceEnv: 'MAXIM_EXPECTED_DEPLOY_SHA',
    args: ['--preview'],
  },
];
const request = '{"version":1,"operation":"status"}\n';

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function marker(root, name) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(readFileSync(join(root, name), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await delay(10);
  }
  assert.fail(`Owned controller did not write ${name}`);
}

function fixture(definition, mode = 'normal') {
  const root = mkdtempSync(join(tmpdir(), 'maxim-cold-wrapper-'));
  const scripts = join(root, 'infra/scripts');
  mkdirSync(join(scripts, 'lib'), { recursive: true });
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const sha = 'a'.repeat(40);
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(
    join(bin, 'git'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == -C ]]; then exec '${realGit}' "$@"; fi
case "$*" in
  'rev-parse HEAD') printf '%s\\n' '${sha}' ;;
  'status --porcelain --untracked-files=no'|'status --porcelain --untracked-files=normal') ;;
  *) exit 98 ;;
esac
`,
    { mode: 0o700 },
  );
  const wrapper = join(scripts, definition.wrapper);
  writeFileSync(wrapper, readFileSync(new URL(`./${definition.wrapper}`, import.meta.url)));
  const lock = deployLockFixture(root, join(scripts, 'lib/deploy-lock.sh'));
  // FLAG: Replace only the controller workload; both inherited flock descriptors remain real.
  writeFileSync(
    join(scripts, definition.host),
    `
import { fstatSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
for (const [fdName, identityName] of [['MAXIM_DEPLOY_LOCK_FD', 'MAXIM_DEPLOY_LOCK_IDENTITY'], ['PAIR_RELEASE_ADMISSION_FD', null]]) {
  const fd = Number(process.env[fdName]);
  const stat = fstatSync(fd);
  if (process.env.MAXIM_DEPLOY_LOCK_VERSION !== 'flock-v1' ||
    identityName && process.env[identityName] !== stat.dev + ':' + stat.ino ||
    !readFileSync('/proc/self/fdinfo/' + fd, 'utf8').includes('FLOCK')) throw new Error('lock lost');
}
if (JSON.stringify(process.argv.slice(2)) !== process.env.FIXTURE_EXPECTED_ARGS) throw new Error('arguments changed');
const root = process.env.FIXTURE_ROOT;
const mark = (name, value) => writeFileSync(join(root, name), JSON.stringify(value));
const finish = code => { mark('finished.json', {pid: process.pid, code}); process.exit(code); };
let closing = false;
for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(signal, () => {
  if (closing) return;
  closing = true;
  mark('cleaning.json', {pid: process.pid, signal});
  const drain = () => { if (existsSync(join(root, 'allow-cleanup'))) finish(process.env.FIXTURE_MODE === 'signal-deny' ? 3 : 0); };
  drain(); setInterval(drain, 10);
});
process.stdout.write(JSON.stringify({pid: process.pid, args: process.argv.slice(2)}) + '\\n');
let input = '';
for await (const chunk of process.stdin) input += chunk;
if (JSON.parse(input).operation !== 'status') throw new Error('request changed');
mark('received.json', {input});
if (['signal', 'signal-deny'].includes(process.env.FIXTURE_MODE)) await new Promise(() => setInterval(() => {}, 1000));
else finish(process.env.FIXTURE_MODE === 'nonzero' ? 37 : process.env.FIXTURE_MODE === 'preflight-deny' ? 3 : 0);
`,
  );
  const env = deployLockEnvironment({
    PATH: `${bin}:${process.env.PATH}`,
    [definition.sourceEnv]: sha,
    FIXTURE_ROOT: root,
    FIXTURE_MODE: mode,
    FIXTURE_EXPECTED_ARGS: JSON.stringify(definition.hostArgs ?? definition.args),
  });
  const observe = () =>
    spawnSync(
      'bash',
      [
        '-c',
        'source "$1"; acquire_deploy_lock || exit "$?"; release_deploy_lock',
        'fixture',
        lock.helper,
      ],
      { env, encoding: 'utf8', timeout: 3000 },
    );
  const kernelFree = (path) => spawnSync('flock', ['-n', path, 'true']).status === 0;
  return {
    root,
    wrapper,
    lock,
    env,
    observe,
    kernelFree,
    hostArgs: definition.hostArgs ?? definition.args,
  };
}

test(
  'source typed preflight denial keeps exit one and releases the exact admission owner',
  { timeout: 8000 },
  async (t) => {
    const definition = wrappers.find(({ name }) => name === 'source');
    const h = fixture(definition, 'preflight-deny');
    const running = await launch(t, h, definition.args);
    assert.equal(h.kernelFree(h.lock.file), false);
    assert.equal(h.kernelFree(h.lock.pair.file), false);
    running.child.stdin.end(request);
    assert.equal((await running.done)[0], 1, running.stderr());
    assert.equal((await marker(h.root, 'finished.json')).code, 3);
    assert.equal(existsSync(join(h.lock.pair.state, 'admission.owner')), false);
    assert.equal(h.kernelFree(h.lock.file), true);
    assert.equal(h.kernelFree(h.lock.pair.file), true);
    assert.equal(h.observe().status, 0);
  },
);

for (const definition of wrappers.filter(({ name }) => name !== 'source'))
  test(
    `${definition.name} cannot nominate the source-only completion code`,
    { timeout: 8000 },
    async (t) => {
      const h = fixture(definition, 'preflight-deny');
      const running = await launch(t, h, definition.args);
      running.child.stdin.end(request);
      assert.equal((await running.done)[0], 3, running.stderr());
      assert.equal(existsSync(join(h.lock.pair.state, 'admission.owner')), true);
      assert.notEqual(h.observe().status, 0);
    },
  );

for (const missing of ['fixed profile', 'original child identity'])
  test(
    `source reserved completion without ${missing} retains its owner`,
    { timeout: 8000 },
    async (t) => {
      const definition = { ...wrappers.find(({ name }) => name === 'source') };
      if (missing === 'fixed profile') definition.hostArgs = [];
      const h = fixture(definition, 'preflight-deny');
      if (missing === 'fixed profile')
        writeFileSync(
          h.wrapper,
          readFileSync(h.wrapper, 'utf8').replace(' --supervised-preflight', ''),
        );
      else
        writeFileSync(
          h.lock.helper,
          readFileSync(h.lock.helper, 'utf8').replace(
            /_maxim_deploy_controller_start\(\) \{[\s\S]*?\n\}/u,
            '_maxim_deploy_controller_start() { return 1; }',
          ),
        );
      const running = await launch(t, h, definition.args);
      running.child.stdin.end(request);
      assert.equal((await running.done)[0], 3, running.stderr());
      assert.equal(existsSync(join(h.lock.pair.state, 'admission.owner')), true);
      assert.notEqual(h.observe().status, 0);
    },
  );

test(
  'source reserved completion after a parent signal retains uncertain admission',
  { timeout: 8000 },
  async (t) => {
    const definition = wrappers.find(({ name }) => name === 'source');
    const h = fixture(definition, 'signal-deny');
    const running = await launch(t, h, definition.args);
    running.child.stdin.end(request);
    await marker(h.root, 'received.json');
    process.kill(running.child.pid, 'SIGTERM');
    await marker(h.root, 'cleaning.json');
    assert.equal(h.kernelFree(h.lock.file), false);
    assert.equal(h.kernelFree(h.lock.pair.file), false);
    writeFileSync(join(h.root, 'allow-cleanup'), 'release');
    assert.equal((await running.done)[0], 3, running.stderr());
    assert.equal(existsSync(join(h.lock.pair.state, 'admission.owner')), true);
    assert.notEqual(h.observe().status, 0);
  },
);

test(
  'source denial observed during completion freeze retains its owner and signal status',
  { timeout: 8000 },
  async (t) => {
    const definition = wrappers.find(({ name }) => name === 'source');
    const h = fixture(definition, 'preflight-deny');
    const hook = join(h.root, 'freeze-hook.sh');
    // FLAG: Only the fixture's parent intercepts the actual trap builtin. Deliver
    // TERM after branch selection but before signals freeze, without timing sleeps.
    writeFileSync(
      hook,
      `trap() {
  if [[ "$#" == 4 && "$1" == '' && "$2" == INT && "$3" == TERM && "$4" == HUP &&
        "${'${PAIR_RELEASE_ADMISSION_OWNER_PID:-}'}" == "$BASHPID" && "${'${FIXTURE_MODE:-}'}" == preflight-deny ]]; then
    printf 'observed\\n' >"$FIXTURE_ROOT/freeze-signal-observed"
    kill -TERM "$BASHPID"
  fi
  builtin trap "$@"
}
`,
      { mode: 0o600 },
    );
    h.env.BASH_ENV = hook;
    const running = await launch(t, h, definition.args);
    running.child.stdin.end(request);
    assert.equal((await running.done)[0], 143, running.stderr());
    assert.equal(existsSync(join(h.root, 'freeze-signal-observed')), true);
    assert.equal(existsSync(join(h.lock.pair.state, 'admission.owner')), true);
    assert.equal(h.kernelFree(h.lock.file), true);
    assert.equal(h.kernelFree(h.lock.pair.file), true);
    assert.notEqual(h.observe().status, 0);
  },
);

async function launch(t, h, args) {
  const child = spawn('bash', [h.wrapper, ...args], {
    env: h.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const done = once(child, 'close');
  let stderr = '';
  let nodePid;
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(async () => {
    writeFileSync(join(h.root, 'allow-cleanup'), 'release');
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([done, delay(500)]);
    if (nodePid && alive(nodePid)) process.kill(nodePid, 'SIGKILL');
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await done;
    rmSync(h.root, { recursive: true, force: true });
  });
  const first = await Promise.race([
    once(child.stdout, 'data'),
    done.then(([code]) => {
      throw new Error(`controller exited early: ${code}; ${stderr}`);
    }),
  ]);
  const started = JSON.parse(first[0].toString());
  nodePid = started.pid;
  assert.notEqual(nodePid, child.pid);
  assert.deepEqual(started.args, h.hostArgs);
  return { child, done, nodePid, stderr: () => stderr };
}

for (const definition of wrappers) {
  test(
    `${definition.name} keeps both real flocks through stdin and normal completion releases admission`,
    { timeout: 8_000 },
    async (t) => {
      const h = fixture(definition);
      const running = await launch(t, h, definition.args);
      assert.equal(h.kernelFree(h.lock.file), false);
      assert.equal(h.kernelFree(h.lock.pair.file), false);
      assert.notEqual(h.observe().status, 0);
      running.child.stdin.end(request);
      assert.equal((await running.done)[0], 0, running.stderr());
      assert.equal((await marker(h.root, 'received.json')).input, request);
      assert.equal(h.kernelFree(h.lock.file), true);
      assert.equal(h.kernelFree(h.lock.pair.file), true);
      assert.equal(existsSync(join(h.lock.pair.state, 'admission.owner')), false);
      assert.equal(h.observe().status, 0);
    },
  );

  test(`${definition.name} source mismatch and extra arguments refuse before the controller starts`, (t) => {
    const h = fixture(definition);
    t.after(() => rmSync(h.root, { recursive: true, force: true }));
    for (const [args, env] of [
      [definition.args, { ...h.env, [definition.sourceEnv]: 'b'.repeat(40) }],
      [['--bypass'], h.env],
    ]) {
      const result = spawnSync('bash', [h.wrapper, ...args], {
        env,
        encoding: 'utf8',
        timeout: 3000,
      });
      assert.equal(result.status, 2);
      assert.equal(result.stdout, '');
      assert.equal(existsSync(join(h.lock.pair.state, 'admission.owner')), false);
    }
  });

  test(
    `${definition.name} preserves a nonzero controller outcome and unresolved admission`,
    { timeout: 8_000 },
    async (t) => {
      const h = fixture(definition, 'nonzero');
      const running = await launch(t, h, definition.args);
      running.child.stdin.end(request);
      assert.equal((await running.done)[0], 37, running.stderr());
      assert.equal((await marker(h.root, 'finished.json')).code, 37);
      assert.equal(h.kernelFree(h.lock.file), true);
      assert.equal(h.kernelFree(h.lock.pair.file), true);
      assert.equal(existsSync(join(h.lock.pair.state, 'admission.owner')), true);
      assert.notEqual(h.observe().status, 0);
    },
  );

  for (const [signal, expectedCode] of [
    ['SIGTERM', 143],
    ['SIGINT', 130],
    ['SIGHUP', 129],
  ])
    test(
      `${definition.name} shell-only ${signal} waits for exact child cleanup and preserves uncertain admission`,
      { timeout: 8_000 },
      async (t) => {
        const h = fixture(definition, 'signal');
        const running = await launch(t, h, definition.args);
        const observer = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
          stdio: 'ignore',
        });
        const observerDone = once(observer, 'close');
        t.after(async () => {
          observer.kill('SIGTERM');
          await observerDone;
        });
        running.child.stdin.end(request);
        await marker(h.root, 'received.json');
        process.kill(running.child.pid, signal);
        assert.deepEqual(await marker(h.root, 'cleaning.json'), { pid: running.nodePid, signal });
        assert.equal(alive(running.nodePid), true);
        assert.equal(alive(observer.pid), true);
        assert.equal(h.kernelFree(h.lock.file), false);
        assert.equal(h.kernelFree(h.lock.pair.file), false);
        assert.equal(existsSync(join(h.root, 'finished.json')), false);
        writeFileSync(join(h.root, 'allow-cleanup'), 'release');
        const [code, exitSignal] = await running.done;
        assert.equal(code, expectedCode, running.stderr());
        assert.equal(exitSignal, null);
        assert.equal((await marker(h.root, 'finished.json')).pid, running.nodePid);
        assert.equal(alive(running.nodePid), false);
        assert.equal(alive(observer.pid), true);
        assert.equal(h.kernelFree(h.lock.file), true);
        assert.equal(h.kernelFree(h.lock.pair.file), true);
        assert.equal(existsSync(join(h.lock.pair.state, 'admission.owner')), true);
        assert.notEqual(h.observe().status, 0);
      },
    );
}
