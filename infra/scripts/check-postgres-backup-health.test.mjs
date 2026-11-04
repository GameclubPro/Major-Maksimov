import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkPostgresBackupHealth } from './check-postgres-backup-health.mjs';

test('backup health requires independent readback and recent isolated restore, not dump existence', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'maxim-backup-health-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const now = Date.parse('2026-10-13T10:00:00Z');
  const dump = 'maxim_20261013T090000Z.dump';
  await writeFile(join(dir, dump), 'unverified bytes');
  assert.equal((await checkPostgresBackupHealth(dir, now)).ok, false);
  const common = {
    schemaVersion: 1,
    dump,
    dumpSha256: 'a'.repeat(64),
    verifiedAt: new Date(now - 3600_000).toISOString(),
  };
  await writeFile(
    join(dir, `${dump}.remote-verified.json`),
    JSON.stringify({
      ...common,
      cipherSha256: 'b'.repeat(64),
      verification: 'full_ciphertext_readback',
    }),
  );
  assert.deepEqual((await checkPostgresBackupHealth(dir, now)).problems, ['restore_overdue']);
  await writeFile(
    join(dir, `${dump}.restore-verified.json`),
    JSON.stringify({
      ...common,
      network: 'none',
      verification: 'isolated_restore_and_authority_schema',
    }),
  );
  assert.equal((await checkPostgresBackupHealth(dir, now)).ok, true);
  assert.deepEqual((await checkPostgresBackupHealth(dir, now + 29 * 3600_000)).problems, [
    'independent_backup_overdue',
    'independent_backup_data_overdue',
  ]);
  assert.deepEqual((await checkPostgresBackupHealth(dir, now + 9 * 86400_000)).problems, [
    'independent_backup_overdue',
    'independent_backup_data_overdue',
    'restore_overdue',
  ]);
});

test('backup health refuses future evidence and symlinked receipts', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'maxim-backup-health-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dump = 'maxim_20261013T090000Z.dump';
  const file = join(dir, `${dump}.remote-verified.json`);
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      dump,
      dumpSha256: 'a'.repeat(64),
      cipherSha256: 'b'.repeat(64),
      verifiedAt: new Date(Date.now() + 86400_000).toISOString(),
      verification: 'full_ciphertext_readback',
    }),
  );
  assert.ok((await checkPostgresBackupHealth(dir)).problems.includes('invalid_receipt'));
  await symlink(file, join(dir, `${dump}.restore-verified.json`));
  assert.equal((await checkPostgresBackupHealth(dir)).ok, false);
});

test('Lastik health cannot be satisfied by primary receipts or a mismatched profile', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'eraser-backup-health-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const now = Date.parse('2026-10-29T01:00:00Z'),
    dump = 'eraser_20261029T000000Z.dump';
  const receipt = {
    schemaVersion: 1,
    profile: 'eraser',
    dump,
    dumpSha256: 'a'.repeat(64),
    verifiedAt: new Date(now).toISOString(),
  };
  for (const [suffix, extra] of [
    ['remote', { cipherSha256: 'b'.repeat(64), verification: 'full_ciphertext_readback' }],
    [
      'restore',
      {
        schemaDigest: 'c'.repeat(64),
        network: 'none',
        verification: 'isolated_restore_and_eraser_schema',
      },
    ],
  ])
    await writeFile(
      join(dir, `${dump}.${suffix}-verified.json`),
      JSON.stringify({ ...receipt, ...extra }),
    );
  assert.equal((await checkPostgresBackupHealth(dir, now, 'eraser')).ok, true);
  assert.equal((await checkPostgresBackupHealth(dir, now, 'maxim')).ok, false);
  await writeFile(
    join(dir, `${dump}.restore-verified.json`),
    JSON.stringify({
      ...receipt,
      profile: 'maxim',
      schemaDigest: 'c'.repeat(64),
      network: 'none',
      verification: 'isolated_restore_and_eraser_schema',
    }),
  );
  assert.ok(
    (await checkPostgresBackupHealth(dir, now, 'eraser')).problems.includes('invalid_receipt'),
  );
  await assert.rejects(checkPostgresBackupHealth(dir, now, 'arbitrary'));
});

async function writeReceipt(directory, dump, verifiedAt, kind = 'remote', overrides = {}) {
  const profile = dump.startsWith('eraser_') ? 'eraser' : 'maxim';
  const proof =
    kind === 'remote'
      ? { cipherSha256: 'b'.repeat(64), verification: 'full_ciphertext_readback' }
      : {
          network: 'none',
          schemaDigest: 'c'.repeat(64),
          verification:
            profile === 'eraser'
              ? 'isolated_restore_and_eraser_schema'
              : 'isolated_restore_and_authority_schema',
        };
  await writeFile(
    join(directory, `${dump}.${kind}-verified.json`),
    JSON.stringify({
      schemaVersion: 1,
      profile,
      dump,
      dumpSha256: 'a'.repeat(64),
      verifiedAt,
      ...proof,
      ...overrides,
    }),
  );
}

for (const profile of ['maxim', 'eraser']) {
  test(`${profile} independent evidence expires after 24 hours, including fresh readback of old data`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'maxim-backup-freshness-boundary-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const generatedAt = Date.parse('2026-11-02T12:00:00Z');
    const dump = `${profile}_20261102T120000Z.dump`;
    await writeReceipt(dir, dump, new Date(generatedAt).toISOString(), 'restore');
    for (const ageMs of [23 * 3600_000, 24 * 3600_000, 24 * 3600_000 + 1]) {
      const now = generatedAt + ageMs;
      const overdue = ageMs > 24 * 3600_000;
      await writeReceipt(dir, dump, new Date(generatedAt).toISOString());
      const original = await checkPostgresBackupHealth(dir, now, profile);
      assert.deepEqual(
        original.problems,
        overdue ? ['independent_backup_overdue', 'independent_backup_data_overdue'] : [],
        `original readback at age ${ageMs}`,
      );
      assert.equal(original.independentVerificationAgeMs, ageMs);
      assert.equal(original.independentDataAgeMs, ageMs);

      await writeReceipt(dir, dump, new Date(now - 3600_000).toISOString());
      const reread = await checkPostgresBackupHealth(dir, now, profile);
      assert.deepEqual(
        reread.problems,
        overdue ? ['independent_backup_data_overdue'] : [],
        `fresh readback at data age ${ageMs}`,
      );
      assert.equal(reread.independentVerificationAgeMs, 3600_000);
      assert.equal(reread.independentDataAgeMs, ageMs);
    }
  });

  test(`${profile} fresh verification cannot renew old backup data`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'maxim-backup-data-age-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const now = Date.parse('2026-11-03T12:00:00Z');
    const dump = `${profile}_20261101T120000Z.dump`;
    await writeReceipt(dir, dump, '2026-11-03T11:00:00Z');
    await writeReceipt(dir, dump, '2026-11-03T11:30:00Z', 'restore');
    const report = await checkPostgresBackupHealth(dir, now, profile);
    assert.deepEqual(report.problems, ['independent_backup_data_overdue']);
    assert.equal(report.independentDump, dump);
    assert.equal(report.independentDataAgeMs, 48 * 3600_000);
    assert.equal(report.independentVerificationAgeMs, 3600_000);
    assert.equal(report.independentAgeMs, report.independentVerificationAgeMs);
    assert.equal(report.restoreDataAgeMs, 48 * 3600_000);
    assert.equal(report.restoreVerificationAgeMs, 1800_000);
    assert.equal(report.restoreAgeMs, report.restoreVerificationAgeMs);
    assert.equal(report.sourceTimeBasis, 'archive_generation_start');
  });
}

test('independent ages describe the same freshest data receipt, not separate maxima', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'maxim-backup-coherent-age-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const now = Date.parse('2026-11-03T12:00:00Z');
  const newer = 'maxim_20261103T090000Z.dump';
  const older = 'maxim_20261101T120000Z.dump';
  await writeReceipt(dir, newer, '2026-11-03T10:00:00Z');
  await writeReceipt(dir, older, '2026-11-03T11:00:00Z');
  // Receipt evidence remains usable after ordinary local archive retention.
  const report = await checkPostgresBackupHealth(dir, now);
  assert.equal(report.independentDump, newer);
  assert.equal(report.independentGeneratedAt, '2026-11-03T09:00:00.000Z');
  assert.equal(report.independentVerifiedAt, '2026-11-03T10:00:00.000Z');
  assert.equal(report.independentDataAgeMs, 3 * 3600_000);
  assert.equal(report.independentVerificationAgeMs, 2 * 3600_000);
  assert.deepEqual(report.problems, ['restore_overdue']);
});

test('restore freshness selects the latest exercise and retains its own older source age', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'maxim-restore-coherent-age-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const now = Date.parse('2026-11-03T12:00:00Z');
  const newer = 'maxim_20261103T090000Z.dump';
  const older = 'maxim_20261001T000000Z.dump';
  await writeReceipt(dir, newer, '2026-11-03T10:00:00Z');
  await writeReceipt(dir, newer, '2026-11-03T10:30:00Z', 'restore');
  await writeReceipt(dir, older, '2026-11-03T11:00:00Z', 'restore');
  const report = await checkPostgresBackupHealth(dir, now);
  assert.equal(report.restoreDump, older);
  assert.equal(report.restoreGeneratedAt, '2026-10-01T00:00:00.000Z');
  assert.equal(report.restoreVerifiedAt, '2026-11-03T11:00:00.000Z');
  assert.equal(report.restoreDataAgeMs, now - Date.parse('2026-10-01T00:00:00Z'));
  assert.equal(report.restoreVerificationAgeMs, 3600_000);
  assert.equal(report.ok, true);
});

test('archive calendar and generation chronology must be valid before receipt admission', async (t) => {
  for (const [dump, verifiedAt, overrides] of [
    ['maxim_20260230T000000Z.dump', '2026-11-03T11:00:00Z', {}],
    ['maxim_20261103T240000Z.dump', '2026-11-03T11:00:00Z', {}],
    ['maxim_20261104T000000Z.dump', '2026-11-03T11:00:00Z', {}],
    ['maxim_20261103T110000Z.dump', '2026-11-03T10:00:00Z', {}],
    ['maxim_20261103T090000Z.dump', '2026-11-03T11:00:00Z', { schemaVersion: 2 }],
  ]) {
    const dir = await mkdtemp(join(tmpdir(), 'maxim-invalid-backup-age-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeReceipt(dir, dump, verifiedAt, 'remote', overrides);
    const report = await checkPostgresBackupHealth(dir, Date.parse('2026-11-03T12:00:00Z'));
    assert.ok(report.problems.includes('invalid_receipt'), dump);
    assert.equal(report.independentDump, null, dump);
    assert.equal(report.independentDataAgeMs, null, dump);
    assert.equal(report.independentVerificationAgeMs, null, dump);
  }
});
