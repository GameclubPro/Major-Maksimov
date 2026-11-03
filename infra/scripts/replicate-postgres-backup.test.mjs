import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const script = resolve(import.meta.dirname, 'replicate-postgres-backup.sh');
const ageAvailable = spawnSync('age', ['--version']).status === 0;

for (const profile of ['maxim', 'eraser']) {
  for (const scenario of ['valid', 'corrupt', 'foreign-checksum', 'changed-scheduled-hash']) {
    const corrupt = scenario === 'corrupt';
    const foreignChecksum = scenario === 'foreign-checksum';
    const accepted = scenario === 'valid';
    test(
      `independent backup verifies full ciphertext readback, profile=${profile}, scenario=${scenario}`,
      { skip: !ageAvailable },
      (t) => {
        const dir = mkdtempSync(join(tmpdir(), 'maxim-independent-backup-'));
        t.after(() => rmSync(dir, { recursive: true, force: true }));
        const bin = join(dir, 'bin');
        const remote = join(dir, 'remote');
        mkdirSync(bin);
        mkdirSync(remote);
        const key = join(dir, 'key');
        assert.equal(spawnSync('age-keygen', ['-o', key]).status, 0);
        const recipients = join(dir, 'recipients');
        writeFileSync(
          recipients,
          spawnSync('age-keygen', ['-y', key], { encoding: 'utf8' }).stdout,
        );
        writeFileSync(join(dir, 'config'), 'private-placeholder', { mode: 0o600 });
        writeFileSync(
          join(bin, 'rclone'),
          `#!/usr/bin/env python3
import os,sys,shutil
from pathlib import Path
a=sys.argv[1:]; root=Path(os.environ['TEST_REMOTE'])
if a[0]=='copyto':
 shutil.copyfile(a[1],root/Path(a[2]).name)
elif a[0]=='cat':
 data=(root/Path(a[1]).name).read_bytes()
 sys.stdout.buffer.write(data + (b'corruption' if os.environ['TEST_CORRUPT']=='1' else b''))
else: sys.exit(2)
`,
          { mode: 0o700 },
        );
        const name = `${profile}_20261013T000000Z.dump`;
        const dump = join(dir, name);
        const plain = Buffer.from('synthetic PostgreSQL archive, never production data\n');
        writeFileSync(dump, plain);
        const sha = createHash('sha256').update(plain).digest('hex');
        const foreign = Buffer.from('different archive');
        writeFileSync(join(dir, 'unrelated.dump'), foreign);
        writeFileSync(
          `${dump}.sha256`,
          foreignChecksum
            ? `${createHash('sha256').update(foreign).digest('hex')}  unrelated.dump\n`
            : `${sha}  ${name}\n`,
        );
        const env = {
          ...process.env,
          MAXIM_BACKUP_PROFILE: profile,
          PATH: `${bin}:${process.env.PATH}`,
          TEST_REMOTE: remote,
          TEST_CORRUPT: corrupt ? '1' : '0',
          MAXIM_BACKUP_AGE_RECIPIENTS: recipients,
          MAXIM_BACKUP_RCLONE_CONFIG: join(dir, 'config'),
          MAXIM_BACKUP_REMOTE_PREFIX: 'test:bucket/postgres///',
          MAXIM_BACKUP_MIN_FREE_BYTES: '1048576',
          MAXIM_BACKUP_REPLICATION_TIMEOUT_SEC: '30',
          MAXIM_BACKUP_EXPECTED_SHA256:
            scenario === 'changed-scheduled-hash' ? 'a'.repeat(64) : sha,
        };
        const result = spawnSync('bash', [script, dump], {
          env,
          encoding: 'utf8',
          timeout: 35_000,
        });
        assert.equal(result.status === 0, accepted, result.stderr);
        const files = readdirSync(remote);
        if (foreignChecksum || scenario === 'changed-scheduled-hash') assert.deepEqual(files, []);
        assert.equal(
          files.some((file) => file.endsWith('.verified.json')),
          accepted,
        );
        if (accepted) {
          const receipt = JSON.parse(readFileSync(`${dump}.remote-verified.json`, 'utf8'));
          assert.equal(receipt.dumpSha256, sha);
          assert.equal(receipt.profile, profile);
          assert.equal(receipt.remoteObject.includes('/eraser/'), profile === 'eraser');
          assert.equal(receipt.remoteObject.includes('//'), false);
          assert.equal(receipt.verification, 'full_ciphertext_readback');
          const encrypted = files.find((file) => file.endsWith('.age'));
          const decrypted = spawnSync('age', ['-d', '-i', key, join(remote, encrypted)]);
          assert.equal(decrypted.status, 0);
          assert.deepEqual(decrypted.stdout, plain);
          assert.notEqual(readFileSync(join(remote, encrypted)).indexOf(plain), 0);
        }
        assert.equal(
          readdirSync(dir).some((file) => file.startsWith(`.${profile}-independent.`)),
          false,
        );
        assert.deepEqual(readFileSync(dump), plain);
      },
    );
  }
}
