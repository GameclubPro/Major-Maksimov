import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const GH_CLI_PIN = Object.freeze({
  version: '2.103.3',
  archiveSha256: '4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d',
  binarySha256: 'b768184570b12536be4ac1528893f6340d1c6a7b40b56ad45bca9cd0e87ad34d',
});

export function assertPinnedGhBinary(path) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 100 * 1024 ** 2 ||
    createHash('sha256').update(readFileSync(path)).digest('hex') !== GH_CLI_PIN.binarySha256
  ) {
    throw new Error('GitHub CLI does not match the reviewed attestation verifier.');
  }
  return path;
}

// FLAG: Verification output is a versioned security boundary. Use the pinned upstream
// binary, verified independently of its download location; never install a mutable latest URL.
export function ensureGitHubCli(env = process.env) {
  if (env.MAXIM_GH_BINARY) return assertPinnedGhBinary(env.MAXIM_GH_BINARY);
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('Registry verification requires the reviewed Linux amd64 GitHub CLI.');
  }
  const cache = join(
    env.XDG_CACHE_HOME || join(homedir(), '.cache'),
    'maxim',
    `gh-${GH_CLI_PIN.version}`,
  );
  const destination = join(cache, 'gh');
  if (existsSync(destination)) return assertPinnedGhBinary(destination);
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const temporary = mkdtempSync(join(tmpdir(), 'maxim-gh-cli-'));
  try {
    const archive = join(temporary, 'gh.tar.gz');
    const invoke = (binary, args) => {
      const result = spawnSync(binary, args, {
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 1024 ** 2,
      });
      if (result.status !== 0) throw new Error(`Pinned GitHub CLI preparation failed: ${binary}.`);
    };
    invoke('curl', [
      '--fail',
      '--silent',
      '--show-error',
      '--location',
      '--proto',
      '=https',
      '--proto-redir',
      '=https',
      '--connect-timeout',
      '15',
      '--max-time',
      '110',
      '--max-filesize',
      String(80 * 1024 ** 2),
      '--output',
      archive,
      `https://github.com/cli/cli/releases/download/v${GH_CLI_PIN.version}/gh_${GH_CLI_PIN.version}_linux_amd64.tar.gz`,
    ]);
    if (
      createHash('sha256').update(readFileSync(archive)).digest('hex') !== GH_CLI_PIN.archiveSha256
    ) {
      throw new Error('GitHub CLI release archive checksum mismatch.');
    }
    invoke('tar', [
      '-xzf',
      archive,
      '-C',
      temporary,
      `gh_${GH_CLI_PIN.version}_linux_amd64/bin/gh`,
    ]);
    const extracted = join(temporary, `gh_${GH_CLI_PIN.version}_linux_amd64/bin/gh`);
    assertPinnedGhBinary(extracted);
    chmodSync(extracted, 0o700);
    // The final installation is atomic; concurrent callers never see partial binary contents.
    const staging = join(cache, `gh-${process.pid}.partial`);
    const copy = spawnSync('cp', [extracted, staging], { encoding: 'utf8' });
    if (copy.status !== 0) throw new Error('Unable to stage the verified GitHub CLI.');
    renameSync(staging, destination);
    return assertPinnedGhBinary(destination);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
