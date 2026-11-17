import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  canonical,
  checkSource,
  configDigest,
  digest,
  expectationFromEnvironment,
  parseProfiles,
  MARKET_OWNER_FILES,
} from './major-market-release-state.mjs';
import { attestRuntime } from './major-market-release-readback.mjs';

const root = resolve(import.meta.dirname, '../..');
const sha = 'a'.repeat(40);
const hash = 'b'.repeat(64);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
function envelope() {
  return {
    schemaVersion: 1,
    protocol: 'major-market-release-v1',
    profiles: ['birzhik-core@1'],
    stateSha256: hash,
    step: {
      product: 'major',
      targetSha: sha,
      components: ['api-shared'],
      archiveSha256: null,
      provenanceSha256: null,
    },
    compatibility: { fixtureSha256: hash, proofRefsDigest: hash },
  };
}
function withEnvelope(value, action, expected = digest(canonical(value))) {
  const old = { ...process.env };
  process.env.MAJOR_MARKET_RELEASE_EXPECTATION_B64 = Buffer.from(JSON.stringify(value)).toString(
    'base64',
  );
  process.env.MAJOR_MARKET_RELEASE_EXPECTED_STATE_SHA256 = expected;
  try {
    return action();
  } finally {
    for (const key of [
      'MAJOR_MARKET_RELEASE_EXPECTATION_B64',
      'MAJOR_MARKET_RELEASE_EXPECTED_STATE_SHA256',
    ]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  }
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'major-market-release-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const replacements = {
    '/etc/maxim-deploy': join(directory, 'etc'),
    '/var/lib/maxim-deploy': join(directory, 'state'),
    '/var/www/Chat_bot': join(directory, 'major'),
    '/var/www/svyazka': join(directory, 'market'),
  };
  let source = readFileSync(new URL('./major-market-release-state.mjs', import.meta.url), 'utf8');
  for (const [before, after] of Object.entries(replacements))
    source = source.replaceAll(before, after);
  // Test-only relocation/privilege adaptation; real opens, modes, inodes, procfs and flock remain.
  source = source
    .replace("if (path === '/') break;", `if (path === ${JSON.stringify(directory)}) break;`)
    .replaceAll('item.uid !== 0', 'item.uid !== process.getuid()')
    .replaceAll('before.uid !== 0n', 'before.uid !== BigInt(process.getuid())');
  const guard = join(directory, 'etc/major-market-release/guard.mjs');
  for (const path of [
    dirname(guard),
    join(directory, 'state'),
    join(directory, 'major'),
    join(directory, 'market/shared'),
    join(directory, 'etc/market-statistics'),
  ])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(guard, source, { mode: 0o444 });
  const marketOwnerFiles = {};
  for (const name of MARKET_OWNER_FILES) {
    const file = join(dirname(guard), 'market-owner', name);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const bytes = `// committed fixture ${name}\n`;
    writeFileSync(file, bytes, { mode: 0o444 });
    marketOwnerFiles[name] = digest(bytes);
  }
  const marker = {
    schemaVersion: 1,
    protocol: 'major-market-release-v1',
    protocolVersion: 1,
    guardSha256: digest(source),
    majorSha: sha,
    marketSha: sha,
    marketOwnerFiles,
  };
  writeFileSync(join(dirname(guard), 'protocol-v1.json'), JSON.stringify(marker), { mode: 0o444 });
  const components = Object.fromEntries(
    ['api-shared', 'admin-static', 'miniapp-major-static'].map((id) => [
      id,
      { sourceSha: sha, imageRef: `maxim-${id}:${sha}`, imageId: `sha256:${hash}` },
    ]),
  );
  writeFileSync(
    join(directory, 'state/current.json'),
    JSON.stringify({ components, createdAt: '2020-01-01' }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(directory, 'market/current.json'),
    JSON.stringify({
      sourceSha: sha,
      image: `svyazka-app:${sha}`,
      imageId: `sha256:${hash}`,
      url: 'https://major-maksimov.ru/market/',
    }),
    { mode: 0o600 },
  );
  writeFileSync(join(directory, 'major/.env'), 'SVYAZKA_PROFILE_TOKEN=one\nUNRELATED=1\n', {
    mode: 0o600,
  });
  writeFileSync(join(directory, 'market/shared/.env.production'), 'MAXIM_PROFILE_TOKEN=one\n', {
    mode: 0o600,
  });
  const run = (...args) => spawnSync('node', [guard, ...args], { encoding: 'utf8', timeout: 5000 });
  return { directory, guard, run };
}
test('strict whole expectation binds target, components, profiles and proof references', () => {
  const value = envelope();
  assert.deepEqual(withEnvelope(value, expectationFromEnvironment), value);
  for (const mutate of [
    (item) => (item.protocol = 'old'),
    (item) => (item.step.targetSha = 'short'),
    (item) => (item.profiles = ['unknown@1']),
    (item) => item.step.components.push('api-shared'),
    (item) => (item.compatibility.extra = true),
    (item) => (item.step.archiveSha256 = hash),
  ]) {
    const invalid = structuredClone(value);
    mutate(invalid);
    assert.throws(() => withEnvelope(invalid, expectationFromEnvironment));
  }
  const other = structuredClone(value);
  other.step.targetSha = 'c'.repeat(40);
  assert.throws(
    () => withEnvelope(other, expectationFromEnvironment, digest(canonical(value))),
    /whole expectation/,
  );
  assert.throws(() => parseProfiles('statistics-central@1,birzhik-core@1'), /unsorted/);
});
test('scoped configuration excludes unrelated values and preserves significant drift', () => {
  const profiles = ['birzhik-core@1'];
  assert.equal(
    configDigest(Buffer.from('SVYAZKA_PROFILE_TOKEN=one\nA=1'), 'major', profiles),
    configDigest(Buffer.from('A=2\nSVYAZKA_PROFILE_TOKEN=one'), 'major', profiles),
  );
  assert.notEqual(
    configDigest(Buffer.from('SVYAZKA_PROFILE_TOKEN=one'), 'major', profiles),
    configDigest(Buffer.from('SVYAZKA_PROFILE_TOKEN=two'), 'major', profiles),
  );
  assert.throws(
    () =>
      configDigest(
        Buffer.from('SVYAZKA_PROFILE_TOKEN=one\nSVYAZKA_PROFILE_TOKEN=two'),
        'major',
        profiles,
      ),
    /duplicate/,
  );
});
test('actual snapshot stays stable across timestamps and unrelated config, refuses unsafe file identities', async (t) => {
  const data = fixture(t);
  const observe = () => {
    const result = data.run('state', '--profiles', 'birzhik-core@1');
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const first = observe();
  writeFileSync(join(data.directory, 'major/.env'), 'UNRELATED=2\nSVYAZKA_PROFILE_TOKEN=one\n');
  const majorPath = join(data.directory, 'state/current.json');
  const manifest = JSON.parse(readFileSync(majorPath));
  manifest.createdAt = 'later';
  writeFileSync(majorPath, JSON.stringify(manifest));
  assert.equal(observe().stateSha256, first.stateSha256);
  manifest.components['api-shared'].imageId = `sha256:${'c'.repeat(64)}`;
  writeFileSync(majorPath, JSON.stringify(manifest));
  assert.notEqual(observe().stateSha256, first.stateSha256);
  const backup = join(data.directory, 'copy');
  copyFileSync(majorPath, backup);
  rmSync(majorPath);
  symlinkSync(backup, majorPath);
  assert.notEqual(data.run('state').status, 0);
  rmSync(majorPath);
  linkSync(backup, majorPath);
  assert.notEqual(data.run('state').status, 0);
  rmSync(majorPath);
  copyFileSync(backup, majorPath);
  chmodSync(majorPath, 0o666);
  assert.notEqual(data.run('state').status, 0);
});
test('real inherited flock is required; environment/open FD alone and replaced inode fail', async (t) => {
  const data = fixture(t);
  const module = await import(pathToFileURL(data.guard));
  const lock = join(data.directory, 'state/deploy.lock');
  writeFileSync(lock, '', { mode: 0o600 });
  const script = (extra) =>
    `set -euo pipefail\nexec 9<>${quote(lock)}\n${extra}\nexport MAXIM_DEPLOY_LOCK_VERSION=flock-v1 MAXIM_DEPLOY_LOCK_OWNER_PID=$BASHPID MAXIM_DEPLOY_LOCK_FD=9\nexport MAXIM_DEPLOY_LOCK_IDENTITY="$(stat -c '%d:%i' ${quote(lock)})"\nnode --input-type=module -e 'import {requireLock} from ${JSON.stringify(pathToFileURL(data.guard).href)}; requireLock();'\ntrue`;
  const run = (extra) =>
    spawnSync('bash', ['-c', script(extra)], { encoding: 'utf8', timeout: 5000 });
  const held = run('flock -n 9');
  assert.equal(held.status, 0, held.stderr);
  assert.notEqual(run(':').status, 0);
  assert.notEqual(
    run(`flock -n 9\nmv ${quote(lock)} ${quote(`${lock}.old`)}\n(umask 077; : >${quote(lock)})`)
      .status,
    0,
  );
  assert.throws(() => module.requireLock(), /owner/);
});
test('source floor checks real Git candidate bytes and executable order', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'major-market-source-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const files = [
    'infra/scripts/lib/deploy-lock.sh',
    'infra/scripts/vps-pull-build-up.sh',
    'infra/scripts/vps-runtime-rollback.sh',
    'infra/scripts/vps-connect.sh',
  ];
  for (const name of files) {
    mkdirSync(dirname(join(directory, name)), { recursive: true });
    copyFileSync(join(root, name), join(directory, name));
  }
  const git = (args) => {
    const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '-q']);
  git(['add', '.']);
  git([
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'candidate',
  ]);
  checkSource(directory, 'major', 'HEAD');
  const path = join(directory, files[1]);
  const original = readFileSync(path, 'utf8');
  for (const changed of [
    original.replace(
      'major_market_release_verify before-build',
      '# major_market_release_verify before-build',
    ),
    original
      .replace('major_market_release_verify before-build', '')
      .replace(
        'prepare_deploy_disk_capacity\nstop_conflicting_stacks',
        'prepare_deploy_disk_capacity\nmajor_market_release_verify before-build\nstop_conflicting_stacks',
      ),
  ]) {
    writeFileSync(path, changed);
    git(['add', '.']);
    git([
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'invalid',
    ]);
    assert.throws(() => checkSource(directory, 'major', 'HEAD'), /hook/);
  }
});

test('locked verification refuses manifest drift before the following build command', (t) => {
  const data = fixture(t);
  const major = join(data.directory, 'major');
  for (const name of [
    'infra/scripts/lib/deploy-lock.sh',
    'infra/scripts/vps-pull-build-up.sh',
    'infra/scripts/vps-runtime-rollback.sh',
    'infra/scripts/vps-connect.sh',
  ]) {
    mkdirSync(dirname(join(major, name)), { recursive: true });
    copyFileSync(join(root, name), join(major, name));
  }
  const git = (args) => {
    const result = spawnSync('git', ['-C', major, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q']);
  git(['add', '.']);
  git([
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'source',
  ]);
  const target = git(['rev-parse', 'HEAD']);
  const observed = JSON.parse(data.run('state', '--profiles', 'birzhik-core@1').stdout);
  const expectation = envelope();
  expectation.stateSha256 = observed.stateSha256;
  expectation.step.targetSha = target;
  const lock = join(data.directory, 'state/deploy.lock');
  writeFileSync(lock, '', { mode: 0o600 });
  const build = join(data.directory, 'built');
  const script = `set -euo pipefail\nexec 9<>${quote(lock)}\nflock -n 9\nexport MAXIM_DEPLOY_LOCK_VERSION=flock-v1 MAXIM_DEPLOY_LOCK_OWNER_PID=$BASHPID MAXIM_DEPLOY_LOCK_FD=9\nexport MAXIM_DEPLOY_LOCK_IDENTITY="$(stat -c '%d:%i' ${quote(lock)})"\nnode ${quote(data.guard)} verify --owner major --phase before-build --source ${quote(major)} --target-sha ${quote(target)} --components api-shared\n: >${quote(build)}\n`;
  const run = () =>
    spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        MAJOR_MARKET_RELEASE_EXPECTATION_B64: Buffer.from(JSON.stringify(expectation)).toString(
          'base64',
        ),
        MAJOR_MARKET_RELEASE_EXPECTED_STATE_SHA256: digest(canonical(expectation)),
      },
    });
  const accepted = run();
  assert.equal(accepted.status, 0, accepted.stderr);
  rmSync(build);
  const path = join(data.directory, 'state/current.json');
  const manifest = JSON.parse(readFileSync(path));
  manifest.components['admin-static'].imageId = `sha256:${'c'.repeat(64)}`;
  writeFileSync(path, JSON.stringify(manifest));
  const refused = run();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /state.*changed/);
  assert.throws(() => readFileSync(build), { code: 'ENOENT' });
});

test('owner runtime attestation rejects wrong image, stale health, duplicate service and changed unselected component', () => {
  const component = {
    id: 'admin-static',
    sourceSha: sha,
    imageRef: `maxim-admin:${sha}`,
    imageId: `sha256:${hash}`,
  };
  const image = {
    Id: component.imageId,
    Config: {
      Labels: { 'org.opencontainers.image.revision': sha, 'com.maxim.release-protected': 'true' },
    },
  };
  const container = {
    Id: 'c'.repeat(64),
    Image: component.imageId,
    Config: {
      Image: component.imageRef,
      Labels: {
        'com.docker.compose.project': 'infra',
        'com.docker.compose.service': 'admin-static',
      },
    },
    State: {
      Running: true,
      Status: 'running',
      Health: { Status: 'healthy' },
      StartedAt: '2026-10-31T00:00:00.000Z',
    },
    RestartCount: 0,
  };
  assert.equal(attestRuntime([component], [container], [image])[0].runtime.length, 1);
  for (const mutate of [
    (item) => (item.Image = `sha256:${'d'.repeat(64)}`),
    (item) => (item.State.Health.Status = 'starting'),
    (item) => (item.Config.Image = 'old:latest'),
  ]) {
    const invalid = structuredClone(container);
    mutate(invalid);
    assert.throws(() => attestRuntime([component], [invalid], [image]), /differs/);
  }
  assert.throws(() => attestRuntime([component], [container, container], [image]), /duplicate/);
  const changed = { ...component, imageId: `sha256:${'d'.repeat(64)}` };
  assert.throws(() => attestRuntime([changed], [container], [image]));
});

test('protected installer publishes complete files atomically, remains idempotent and refuses replacement', (t) => {
  const data = fixture(t);
  const trusted = dirname(data.guard);
  const stage = spawnSync('mktemp', ['-d', '/tmp/major-market-guard.XXXXXXXX'], {
    encoding: 'utf8',
  }).stdout.trim();
  t.after(() => rmSync(stage, { recursive: true, force: true }));
  for (const file of ['guard.mjs', 'protocol-v1.json'])
    copyFileSync(join(trusted, file), join(stage, file));
  for (const name of MARKET_OWNER_FILES) {
    const file = join(stage, 'market-owner', name);
    mkdirSync(dirname(file), { recursive: true });
    copyFileSync(join(trusted, 'market-owner', name), file);
  }
  const hash = digest(readFileSync(join(stage, 'guard.mjs')));
  rmSync(trusted, { recursive: true });
  const installer = readFileSync(
    new URL('./install-major-market-release-guard.sh', import.meta.url),
    'utf8',
  );
  const rootBlock = installer
    .split("<<'ROOT'\n")[1]
    .split('\nROOT\n')[0]
    .replaceAll('/etc/maxim-deploy', join(data.directory, 'etc'))
    .replace('for path in /etc ', `for path in ${quote(data.directory)} `)
    .replaceAll('"$EUID" == 0', `"$EUID" == ${process.getuid()}`)
    .replaceAll('"$owner" == 0', `"$owner" == ${process.getuid()}`)
    .replaceAll('== 0:755', `== ${process.getuid()}:755`)
    .replaceAll('-o root -g root', `-o ${process.getuid()} -g ${process.getgid()}`);
  const run = (source = rootBlock, expected = hash) =>
    spawnSync(
      'bash',
      ['-s', '--', stage, trusted, expected, digest(readFileSync(join(stage, 'protocol-v1.json')))],
      {
        input: source,
        encoding: 'utf8',
        timeout: 5000,
      },
    );
  const interrupted = run(
    rootBlock.replace('install -o', '[[ "$input" != protocol-v1.json ]] || exit 77\n  install -o'),
  );
  assert.equal(interrupted.status, 77, interrupted.stderr);
  assert.equal(existsSync(trusted), false);
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(digest(readFileSync(data.guard)), hash);
  const inode = statSync(data.guard).ino;
  const again = run();
  assert.equal(again.status, 0, again.stderr);
  assert.equal(statSync(data.guard).ino, inode);
  const replacement = run(rootBlock, 'd'.repeat(64));
  assert.notEqual(replacement.status, 0);
  assert.equal(statSync(data.guard).ino, inode);
  assert.equal(statSync(data.guard).mode & 0o777, 0o444);
});

test('archive admission verifies actual Git ancestry, tar digest and every extracted source blob', async (t) => {
  const data = fixture(t);
  const repository = join(data.directory, 'repository');
  mkdirSync(repository);
  const git = (args) => {
    const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q']);
  const commit = (content) => {
    writeFileSync(join(repository, 'owner.txt'), content);
    git(['add', '.']);
    git([
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'source',
    ]);
    return git(['rev-parse', 'HEAD']);
  };
  const previous = commit('old\n');
  const target = commit('new\n');
  const releases = join(data.directory, 'market/releases');
  mkdirSync(releases);
  const source = join(releases, target);
  mkdirSync(source);
  const archive = spawnSync('git', ['-C', repository, 'archive', '--format=tar', target]);
  assert.equal(archive.status, 0);
  writeFileSync(`${source}.tar`, archive.stdout, { mode: 0o600 });
  const extract = spawnSync('tar', ['-xf', `${source}.tar`, '-C', source]);
  assert.equal(extract.status, 0);
  const files = git(['ls-tree', '-r', target])
    .split('\n')
    .map((line) => {
      const [mode, , blob, path] = line.split(/\s+/u);
      return { mode, blob, path };
    });
  const provenance = {
    kind: 'svyazka-committed-source-v1',
    sourceSha: target,
    previousSha: previous,
    treeSha: git(['rev-parse', `${target}^{tree}`]),
    archiveSha256: digest(archive.stdout),
    checkedAt: new Date().toISOString(),
    files,
    commits: [target, previous].map((sha) => ({
      sha,
      raw: Buffer.from(`${git(['cat-file', 'commit', sha])}\n`).toString('base64'),
    })),
  };
  writeFileSync(`${source}.provenance.json`, JSON.stringify(provenance), { mode: 0o600 });
  writeFileSync(
    join(data.directory, 'market/current.json'),
    JSON.stringify({ sourceSha: previous, image: `svyazka-app:${previous}` }),
    { mode: 0o600 },
  );
  const module = await import(pathToFileURL(data.guard));
  assert.equal(module.verifyMarketArchive(target).archiveSha256, digest(archive.stdout));
  writeFileSync(join(source, 'owner.txt'), 'tampered\n');
  assert.throws(() => module.verifyMarketArchive(target), /bytes\/mode/);
  writeFileSync(join(source, 'owner.txt'), 'new\n');
  writeFileSync(`${source}.tar`, Buffer.concat([archive.stdout, Buffer.from('tampered')]));
  assert.throws(() => module.verifyMarketArchive(target), /digest differs/);
});

test('locked observation refuses a live holder and combines owner acceptance with a stable snapshot', async (t) => {
  const data = fixture(t);
  const collector = join(dirname(data.guard), 'market-owner/infra/scripts/release-readback.mjs');
  chmodSync(collector, 0o600);
  const acceptance = {
    schemaVersion: 1,
    protocol: 'major-market-owner-readback-v1',
    product: 'market',
    status: 'passed',
    state: { sourceSha: sha },
    checks: { workerHeartbeat: { status: 'passed' } },
  };
  const code = `process.stdout.write(${JSON.stringify(JSON.stringify(acceptance))});\n`;
  writeFileSync(collector, code, { mode: 0o444 });
  chmodSync(collector, 0o444);
  const markerPath = join(dirname(data.guard), 'protocol-v1.json');
  chmodSync(markerPath, 0o600);
  const marker = JSON.parse(readFileSync(markerPath));
  marker.marketOwnerFiles['infra/scripts/release-readback.mjs'] = digest(code);
  writeFileSync(markerPath, JSON.stringify(marker));
  chmodSync(markerPath, 0o444);
  const lock = join(data.directory, 'state/deploy.lock');
  writeFileSync(lock, '', { mode: 0o600 });
  const inode = statSync(lock).ino;
  const args = [
    'observe-release',
    '--owner',
    'market',
    '--expected-sha',
    sha,
    '--components',
    '',
    '--profiles',
    'birzhik-core@1',
  ];
  const first = data.run(...args);
  if (first.status !== 0) {
    const guard = await import(pathToFileURL(data.guard));
    try {
      guard.main(args);
    } catch (error) {
      assert.fail(String(error.cause?.stderr ?? error));
    }
  }
  assert.equal(first.status, 0, first.stderr);
  const result = JSON.parse(first.stdout);
  assert.equal(result.lock.status, 'held-during-observation');
  assert.match(result.lock.identity, /^\d+:\d+$/u);
  assert.equal(result.acceptance.status, 'passed');
  assert.equal(result.snapshot.state.market.sourceSha, sha);
  assert.equal(statSync(lock).ino, inode);
  const holder = spawn(
    'bash',
    ['-c', `exec 9<${quote(lock)}\nflock -n 9\nprintf ready\nread -r line\n`],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  t.after(() => holder.kill('SIGTERM'));
  await new Promise((resolve, reject) => {
    holder.stdout.once('data', resolve);
    holder.once('error', reject);
  });
  const refused = data.run(...args);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /host lock is busy/);
  holder.stdin.end('done\n');
  await new Promise((resolve) => holder.once('exit', resolve));
  const wrong = data.run(...args.map((value) => (value === sha ? 'c'.repeat(40) : value)));
  assert.notEqual(wrong.status, 0);
  const inherited = spawnSync('node', [data.guard, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MAXIM_DEPLOY_LOCK_VERSION: 'flock-v1' },
    timeout: 5000,
  });
  assert.notEqual(inherited.status, 0);
  assert.match(inherited.stderr, /fresh host lock/);
  const currentPath = join(data.directory, 'market/current.json');
  const changed = JSON.parse(readFileSync(currentPath));
  changed.imageId = `sha256:${'c'.repeat(64)}`;
  const driftingCode = `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(currentPath)},${JSON.stringify(JSON.stringify(changed))});${code}`;
  chmodSync(collector, 0o600);
  writeFileSync(collector, driftingCode);
  chmodSync(collector, 0o444);
  marker.marketOwnerFiles['infra/scripts/release-readback.mjs'] = digest(driftingCode);
  chmodSync(markerPath, 0o600);
  writeFileSync(markerPath, JSON.stringify(marker));
  chmodSync(markerPath, 0o444);
  assert.notEqual(data.run(...args).status, 0);
  rmSync(lock);
  const missing = data.run(...args);
  assert.notEqual(missing.status, 0);
  assert.equal(existsSync(lock), false);
});
