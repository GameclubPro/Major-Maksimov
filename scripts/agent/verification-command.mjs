import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

export function resolveVerificationExecutable(executable, args) {
  if (process.platform !== 'win32' || executable !== 'npm') return { executable, args };

  // Windows npm.cmd needs a shell. Use npm's JS entrypoint to preserve argv without cmd quoting.
  const paths = [...(process.env.PATH ?? '').split(delimiter), dirname(process.execPath)];
  for (const path of paths) {
    if (!isAbsolute(path)) continue;
    const shim = join(path, 'npm.cmd');
    const entrypoint = join(path, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(shim) && existsSync(entrypoint)) {
      return { executable: process.execPath, args: [entrypoint, ...args] };
    }
  }
  throw new Error('Windows npm CLI not found. Install npm with Node 24 and add it to PATH.');
}

export function runVerificationCommand({ executable, args, cwd }, log = null) {
  const command = resolveVerificationExecutable(executable, args);
  const child = spawn(command.executable, command.args, {
    cwd,
    env: { ...process.env, MAXIM_AGENT_VERIFY: '1' },
    stdio: log ? ['inherit', 'pipe', 'pipe'] : 'inherit',
  });
  if (log) {
    child.stdout.on('data', (chunk) => log(chunk));
    child.stderr.on('data', (chunk) => log(chunk));
  }
  return new Promise((resolveRun, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      const error = new Error(
        `${executable} ${args.join(' ')} failed${signal ? ` with ${signal}` : ` with code ${code}`}.`,
      );
      error.exitCode = code;
      error.signal = signal;
      reject(error);
    });
  });
}
