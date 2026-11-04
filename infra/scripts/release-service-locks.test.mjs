import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertReleaseLocks } from './release-service-locks.mjs';

const moduleUrl = new URL('./release-service-locks.mjs', import.meta.url).href;
const token = 'fixture-private-admission-token';
const ownerSource = `
  import * as fs from 'node:fs';
  import {createHash} from 'node:crypto';
  const options = JSON.parse(process.argv[1]);
  const scenario = process.argv[2];
  const sha256 = value => createHash('sha256').update(value).digest('hex');
  const pid = process.env.PAIR_RELEASE_ADMISSION_OWNER_PID;
  const raw = fs.readFileSync('/proc/' + pid + '/stat').toString('utf8');
  const fields = raw.slice(raw.lastIndexOf(') ') + 2).trimEnd().split(/\\s+/u);
  const stat = fs.statSync(options.pairDirectory + '/state/admission.lock', {bigint:true});
  const receipt = {
    protocol:'major-karavan-release-v1', token:process.env.PAIR_RELEASE_ADMISSION_TOKEN,
    product:'major', mode:'runtime', target:'', pid, start:fields[19],
    boot:fs.readFileSync('/proc/sys/kernel/random/boot_id').toString('utf8').trimEnd(),
    cwd:sha256(fs.realpathSync('/proc/' + pid + '/cwd')),
    fd:process.env.PAIR_RELEASE_ADMISSION_FD, inode:stat.dev + ':' + stat.ino,
    initial_state:'a'.repeat(64), started_at:'2026-11-04T05:00:00.000Z'
  };
  const receiptPath = options.pairDirectory + '/state/admission.owner';
  const writeReceipt = () => fs.writeFileSync(receiptPath, Object.entries(receipt).map(([k,v])=>k+'='+v+'\\n').join(''), {mode:0o600});
  writeReceipt();
`;

const verifierSource = `${ownerSource}
  import {assertReleaseLocks} from ${JSON.stringify(moduleUrl)};
  const env = {...process.env};
  if (scenario === 'version') env.MAXIM_DEPLOY_LOCK_VERSION = 'flock-v1\\n';
  if (scenario === 'product-pid') env.MAXIM_DEPLOY_LOCK_OWNER_PID = String(process.pid);
  if (scenario === 'pair-pid') env.PAIR_RELEASE_ADMISSION_OWNER_PID = String(process.pid);
  if (scenario === 'token') env.PAIR_RELEASE_ADMISSION_TOKEN = 'different-admission-token';
  if (scenario === 'identity') env.MAXIM_DEPLOY_LOCK_IDENTITY = '0:123';
  if (scenario === 'state') env.PAIR_RELEASE_EXPECTED_STATE_SHA256 = 'b'.repeat(64);
  if (scenario === 'state-malformed') env.PAIR_RELEASE_EXPECTED_STATE_SHA256 = 'a'.repeat(64)+'\\n';
  if (scenario === 'receipt-boot') receipt.boot = '0'.repeat(8)+'-0000-0000-0000-000000000000';
  if (scenario === 'receipt-start') receipt.start = String(BigInt(receipt.start)+1n);
  if (scenario === 'receipt-cwd') receipt.cwd = 'b'.repeat(64);
  if (scenario === 'receipt-fd') receipt.fd = '12';
  if (scenario === 'receipt-inode') receipt.inode = '0:123';
  if (scenario === 'receipt-product') receipt.product = 'karavan';
  if (scenario === 'receipt-bootstrap') receipt.mode = 'bootstrap';
  if (scenario === 'receipt-tooling') receipt.mode = 'tooling';
  if (scenario === 'receipt-target') receipt.target = 'a'.repeat(40)+'\\n';
  writeReceipt();
  if (scenario === 'receipt-duplicate') fs.appendFileSync(receiptPath,'token='+receipt.token+'\\n');
  if (scenario === 'receipt-oversized') fs.appendFileSync(receiptPath,'x'.repeat(8193));
  if (scenario === 'receipt-utf8') fs.appendFileSync(receiptPath,Buffer.from([255]));
  if (scenario === 'receipt-mode') fs.chmodSync(receiptPath,0o644);
  if (scenario === 'receipt-hardlink') fs.linkSync(receiptPath,receiptPath+'.linked');
  if (scenario === 'receipt-symlink') { fs.renameSync(receiptPath,receiptPath+'.old'); fs.symlinkSync(receiptPath+'.old',receiptPath); }
  if (scenario === 'product-mode') fs.chmodSync(options.productLock,0o640);
  if (scenario === 'product-hardlink') fs.linkSync(options.productLock,options.productLock+'.linked');
  if (scenario === 'product-symlink') { fs.renameSync(options.productLock,options.productLock+'.old'); fs.symlinkSync(options.productLock+'.old',options.productLock); }
  if (scenario === 'product-replaced') { fs.renameSync(options.productLock,options.productLock+'.old'); fs.writeFileSync(options.productLock,'',{mode:0o600}); }
  if (scenario === 'pair-mode') fs.chmodSync(options.pairDirectory+'/state/admission.lock',0o644);
  if (scenario === 'state-mode') fs.chmodSync(options.pairDirectory+'/state',0o750);
  if (scenario === 'directory-mode') fs.chmodSync(options.pairDirectory,0o777);
  if (scenario === 'protocol') fs.writeFileSync(options.pairDirectory+'/protocol-v1','unknown-v1\\n');
  if (scenario === 'reader-hardlink') fs.linkSync(options.pairDirectory+'/state.mjs',options.pairDirectory+'/state.link');
  if (scenario === 'reader-symlink') { const p=options.pairDirectory+'/admission.sh'; fs.renameSync(p,p+'.old'); fs.symlinkSync(p+'.old',p); }
  let raced = false;
  const fileSystem = scenario === 'receipt-race' ? {...fs, statSync(...args) {
    if (!raced) { raced=true; receipt.token='replacement-admission-token'; writeReceipt(); }
    return fs.statSync(...args);
  }} : fs;
  try {
    if (assertReleaseLocks({...options,env,fileSystem}) !== true) process.exit(91);
    process.stdout.write('PROVED\\n');
  } catch (error) {
    if (error.code !== 'LOCK_UNPROVED' || error.message !== 'Release service LOCK_UNPROVED.' || error.message.includes(receipt.token)) process.exit(92);
    process.stdout.write('REFUSED\\n');
    process.exitCode=70;
  }
`;

const shellSource = `
  set -euo pipefail
  exec 10<>"$5"
  exec 11<>"$6"
  if [[ "$4" == product-shared ]]; then flock -sn 10; elif [[ "$4" != product-open ]]; then flock -n 10; fi
  if [[ "$4" == pair-shared ]]; then flock -sn 11; elif [[ "$4" != pair-open ]]; then flock -n 11; fi
  export MAXIM_DEPLOY_LOCK_VERSION=flock-v1
  export MAXIM_DEPLOY_LOCK_OWNER_PID="$BASHPID"
  export MAXIM_DEPLOY_LOCK_FD=10
  export MAXIM_DEPLOY_LOCK_IDENTITY="$(stat -c '%d:%i' "$5")"
  export PAIR_RELEASE_ADMISSION_OWNER_PID="$BASHPID"
  export PAIR_RELEASE_ADMISSION_FD=11
  export PAIR_RELEASE_ADMISSION_TOKEN=${token}
  if [[ "$4" == wrong-inode ]]; then exec 12<>"$7"; export MAXIM_DEPLOY_LOCK_FD=12; fi
  if [[ "$4" == separate-description ]]; then exec 12<>"$5"; export MAXIM_DEPLOY_LOCK_FD=12; fi
  result=0
  "$1" --input-type=module -e "$2" "$3" "$4" || result=$?
  if ((result != 0)); then exit "$result"; fi
`;

function makeFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'maxim-release-locks-')));
  const product = join(root, 'product');
  const pairDirectory = join(root, 'pair');
  const state = join(pairDirectory, 'state');
  for (const directory of [product, pairDirectory, state]) fs.mkdirSync(directory, { mode: 0o700 });
  for (const name of ['protocol-v1', 'admission.sh', 'state.mjs']) {
    fs.writeFileSync(
      join(pairDirectory, name),
      name === 'protocol-v1' ? 'major-karavan-release-v1\n' : 'fixture\n',
      { mode: 0o600 },
    );
  }
  const productLock = join(product, 'deploy.lock');
  const pairLock = join(state, 'admission.lock');
  const other = join(product, 'other.lock');
  for (const path of [productLock, pairLock, other]) fs.writeFileSync(path, '', { mode: 0o600 });
  return {
    root,
    options: { floor: root, productLock, pairDirectory, rootUid: process.getuid() },
    pairLock,
    other,
    cleanup: () => fs.rmSync(root, { force: true, recursive: true }),
  };
}

function verify(scenario) {
  const fixture = makeFixture();
  try {
    const result = spawnSync(
      '/bin/bash',
      [
        '-c',
        shellSource,
        'lock-fixture',
        process.execPath,
        verifierSource,
        JSON.stringify(fixture.options),
        scenario,
        fixture.options.productLock,
        fixture.pairLock,
        fixture.other,
      ],
      { encoding: 'utf8', timeout: 8000, killSignal: 'SIGKILL', maxBuffer: 16384 },
    );
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.stderr, '');
    return { status: result.status, output: result.stdout };
  } finally {
    fixture.cleanup();
  }
}

test('real ancestor holders prove both exclusive kernel locks and runtime/tooling receipt identity', () => {
  for (const scenario of ['held', 'receipt-tooling'])
    assert.deepEqual(verify(scenario), { status: 0, output: 'PROVED\n' }, scenario);
});

test('matching open files and forged environment never stand in for held whole-file flocks', () => {
  for (const scenario of [
    'product-open',
    'pair-open',
    'product-shared',
    'pair-shared',
    'wrong-inode',
    'separate-description',
    'version',
    'product-pid',
    'pair-pid',
    'identity',
    'token',
    'state',
    'state-malformed',
  ]) {
    assert.deepEqual(verify(scenario), { status: 70, output: 'REFUSED\n' }, scenario);
  }
});

test('owner receipt must exactly match live PID/start/boot/cwd/fd/inode and admitted Major mode', () => {
  for (const scenario of [
    'receipt-boot',
    'receipt-start',
    'receipt-cwd',
    'receipt-fd',
    'receipt-inode',
    'receipt-product',
    'receipt-bootstrap',
    'receipt-target',
    'receipt-duplicate',
    'receipt-oversized',
    'receipt-utf8',
    'receipt-race',
  ]) {
    assert.deepEqual(verify(scenario), { status: 70, output: 'REFUSED\n' }, scenario);
  }
});

test('protected installation, persistent inodes and private unlinked receipt are mandatory', () => {
  for (const scenario of [
    'receipt-mode',
    'receipt-hardlink',
    'receipt-symlink',
    'product-mode',
    'product-hardlink',
    'product-symlink',
    'product-replaced',
    'pair-mode',
    'state-mode',
    'directory-mode',
    'protocol',
    'reader-hardlink',
    'reader-symlink',
  ]) {
    assert.deepEqual(verify(scenario), { status: 70, output: 'REFUSED\n' }, scenario);
  }
});

test('a real foreign live flock owner cannot authorize a non-descendant verifier', async () => {
  const fixture = makeFixture();
  const holderSource = `${ownerSource}
    const keys = ['MAXIM_DEPLOY_LOCK_VERSION','MAXIM_DEPLOY_LOCK_OWNER_PID','MAXIM_DEPLOY_LOCK_FD','MAXIM_DEPLOY_LOCK_IDENTITY','PAIR_RELEASE_ADMISSION_OWNER_PID','PAIR_RELEASE_ADMISSION_FD','PAIR_RELEASE_ADMISSION_TOKEN'];
    process.stdout.write(JSON.stringify(Object.fromEntries(keys.map(key=>[key,process.env[key]])))+'\\n');
  `;
  const child = spawn(
    '/bin/bash',
    [
      '-c',
      `${shellSource}\nread -r _`,
      'foreign-lock-fixture',
      process.execPath,
      holderSource,
      JSON.stringify(fixture.options),
      'held',
      fixture.options.productLock,
      fixture.pairLock,
      fixture.other,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], detached: true },
  );
  let timer;
  let cleanupError;
  try {
    const env = await new Promise((resolve, reject) => {
      let output = '';
      timer = setTimeout(() => reject(new Error('foreign holder readiness deadline')), 8000);
      child.once('error', reject);
      child.once('exit', () => reject(new Error('foreign holder exited before readiness')));
      child.stdout.on('data', (chunk) => {
        output += chunk.toString('utf8');
        if (output.length > 16384) reject(new Error('foreign holder output bound'));
        if (output.includes('\n')) {
          clearTimeout(timer);
          resolve(JSON.parse(output.slice(0, output.indexOf('\n'))));
        }
      });
    });
    const inode = fs.statSync(fixture.options.productLock, { bigint: true });
    assert.equal(
      fs.statSync(`/proc/${env.MAXIM_DEPLOY_LOCK_OWNER_PID}/fd/10`, { bigint: true }).ino,
      inode.ino,
    );
    assert.match(
      fs.readFileSync(`/proc/${env.MAXIM_DEPLOY_LOCK_OWNER_PID}/fdinfo/10`).toString('utf8'),
      /FLOCK\s+ADVISORY\s+WRITE/u,
    );
    assert.throws(() => assertReleaseLocks({ ...fixture.options, env }), {
      code: 'LOCK_UNPROVED',
      message: 'Release service LOCK_UNPROVED.',
    });
  } finally {
    clearTimeout(timer);
    const exited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', resolve);
    });
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') cleanupError = error;
    }
    await exited;
    fixture.cleanup();
  }
  assert.ifError(cleanupError);
});

function procStat(pid, parent, start = '100') {
  const fields = ['S', String(parent), ...Array(17).fill('0'), start, ...Array(30).fill('0')];
  return `${pid} (fixture ) process) ${fields.join(' ')}\n`;
}

test('bounded parent traversal refuses malformed records, cycles and chains beyond 32 ancestors', () => {
  for (const kind of ['cycle', 'deep', 'oversized', 'zombie', 'malformed']) {
    const fixture = makeFixture();
    try {
      const proc = join(fixture.root, 'proc');
      fs.mkdirSync(proc, { mode: 0o700 });
      for (let index = 100; index <= 135; index += 1) {
        fs.mkdirSync(join(proc, String(index)), { mode: 0o700 });
        let value = procStat(index, index + 1);
        if (index === 101 && kind === 'cycle') value = procStat(index, 100);
        if (index === 100 && kind === 'oversized') value = 'x'.repeat(8193);
        if (index === 100 && kind === 'zombie') value = value.replace(') S ', ') Z ');
        if (index === 100 && kind === 'malformed') value = 'not a process\n';
        fs.writeFileSync(join(proc, String(index), 'stat'), value, { mode: 0o600 });
      }
      const env = {
        MAXIM_DEPLOY_LOCK_VERSION: 'flock-v1',
        MAXIM_DEPLOY_LOCK_OWNER_PID: '134',
        MAXIM_DEPLOY_LOCK_FD: '10',
        MAXIM_DEPLOY_LOCK_IDENTITY: '0:1',
        PAIR_RELEASE_ADMISSION_OWNER_PID: '135',
        PAIR_RELEASE_ADMISSION_FD: '11',
        PAIR_RELEASE_ADMISSION_TOKEN: token,
      };
      assert.throws(
        () => assertReleaseLocks({ ...fixture.options, proc, pid: 100, env }),
        { code: 'LOCK_UNPROVED', message: 'Release service LOCK_UNPROVED.' },
        kind,
      );
    } finally {
      fixture.cleanup();
    }
  }
});
