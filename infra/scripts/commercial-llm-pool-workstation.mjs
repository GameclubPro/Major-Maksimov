#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  renameSync,
  chmodSync,
  unlinkSync,
  copyFileSync,
  readlinkSync,
  mkdtempSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname, isAbsolute, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { setTimeout as pause } from 'node:timers/promises';
import {
  poolProfile,
  poolIdentityMatches,
  poolModelArgs,
  poolSshArgs,
  poolReconnectDelay,
} from './commercial-llm-pool-profile.mjs';
import { attestPoolModel, poolSession, poolJson } from './commercial-llm-pool-worker.mjs';

const scriptNames = [
  'commercial-llm-pool-workstation.mjs',
  'commercial-llm-pool-profile.mjs',
  'commercial-llm-pool-worker.mjs',
  'commercial-llm-workstation-profile.mjs',
  'commercial-llm-workstation-worker.mjs',
  'commercial-llm-profiles.mjs',
];
const primerSource = '../../apps/api/src/moderation/commercial/commercial-llm.protocol.ts';
const primerName = 'commercial-llm.protocol.ts';
const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const hash = (path) =>
  new Promise((resolveHash, reject) => {
    const digest = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(digest.digest('hex')));
  });

function atomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, typeof value === 'string' ? value : JSON.stringify(value) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  renameSync(temporary, path);
}

function privateFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077)
    throw new Error('pool_private_file_required');
}

function privateDirectory(path) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    stat.mode & 0o077
  )
    throw new Error('pool_private_directory_required');
}

function processStart(pid, readText = (path) => readFileSync(path, 'utf8')) {
  try {
    return readText(`/proc/${pid}/stat`).split(') ')[1].split(' ')[19];
  } catch {
    return null;
  }
}

// FLAG: PID reuse or a foreign command never grants stop/restart authority over another process.
export function readPoolProcess(state, nodeId, readText = (path) => readFileSync(path, 'utf8')) {
  try {
    const record = JSON.parse(readText(join(state, 'status.json')));
    const bundleRoot = join(state, 'bundles') + sep;
    if (
      record.nodeId !== nodeId ||
      !Number.isSafeInteger(record.pid) ||
      record.pid < 2 ||
      !record.startTicks ||
      typeof record.bundle !== 'string' ||
      !resolve(record.bundle).startsWith(bundleRoot) ||
      processStart(record.pid, readText) !== record.startTicks
    )
      return null;
    const args = readText(`/proc/${record.pid}/cmdline`).split('\0');
    const scriptAt = args.indexOf(join(record.bundle, scriptNames[0]));
    if (scriptAt < 1 || args[scriptAt + 1] !== 'run' || args[scriptAt + 2] !== nodeId) return null;
    return record;
  } catch {
    return null;
  }
}

export function poolResumeEnabled(state) {
  try {
    return readFileSync(join(state, 'enabled'), 'utf8') === '1\n';
  } catch {
    return false;
  }
}

async function checkArtifact(directory, artifact) {
  const path = join(directory, artifact.name);
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size !== artifact.bytes ||
    (await hash(path)) !== artifact.sha256
  )
    throw new Error('pool_artifact_identity_refused');
}

function walkFiles(directory, base = directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return walkFiles(path, base);
      if (!entry.isFile() && !entry.isSymbolicLink()) throw new Error('pool_runtime_file_refused');
      return [path.slice(base.length + 1)];
    })
    .sort();
}

async function verifyBundle(bundle) {
  const files = JSON.parse(readFileSync(join(bundle, 'files.json'), 'utf8'));
  const actual = walkFiles(bundle).filter((name) => name !== 'files.json');
  if (JSON.stringify(actual) !== JSON.stringify(Object.keys(files).sort()))
    throw new Error('pool_installed_files_changed');
  for (const [name, expected] of Object.entries(files)) {
    const path = join(bundle, name);
    const stat = lstatSync(path);
    if (expected.target !== undefined) {
      if (
        !stat.isSymbolicLink() ||
        readlinkSync(path) !== expected.target ||
        !resolve(dirname(path), expected.target).startsWith(bundle + sep)
      )
        throw new Error('pool_installed_link_changed');
    } else if (!stat.isFile() || stat.isSymbolicLink() || (await hash(path)) !== expected.sha256)
      throw new Error('pool_installed_file_changed');
  }
}

// FLAG: The supervisor owns only its guarded children; an unexpected exit reaps model and SSH.
const childGuard = `import ctypes,os,signal,sys
parent=os.getppid()
if ctypes.CDLL(None).prctl(1,signal.SIGTERM,0,0,0)!=0: sys.exit(70)
if os.getppid()!=parent or parent==1: sys.exit(71)
os.execvpe(sys.argv[1],sys.argv[1:],os.environ)`;
export function guardedPoolChild(file, args, options) {
  return spawn('/usr/bin/python3', ['-c', childGuard, file, ...args], options);
}

export async function connectPoolTransport(
  model,
  { nodeId, key, signal, connect, attest = attestPoolModel },
) {
  // FLAG: An exit during backoff or attestation cannot advertise a new session for a dead model.
  const running = () =>
    Number.isSafeInteger(model?.pid) &&
    model.pid > 1 &&
    model.exitCode === null &&
    model.signalCode === null &&
    !model.killed;
  if (!running()) throw new Error('pool_model_exit');
  signal?.throwIfAborted();
  await attest(nodeId, key, signal);
  if (!running()) throw new Error('pool_model_exit');
  signal?.throwIfAborted();
  return connect();
}

async function stopChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  let closed = false;
  const done = new Promise((resolveClosed) =>
    child.once('close', () => {
      closed = true;
      resolveClosed();
    }),
  );
  child.kill('SIGTERM');
  await Promise.race([done, pause(3000)]);
  if (!closed) {
    child.kill('SIGKILL');
    await Promise.race([done, pause(2000)]);
  }
  if (!closed) throw new Error('pool_child_teardown_failed');
}

async function assertFreeModelPort(nodeId) {
  return new Promise((resolveFree, reject) => {
    const socket = createConnection({
      host: '127.0.0.1',
      port: Number(new URL(poolProfile(nodeId).http).port),
    });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error('pool_model_port_in_use'));
    });
    socket.once('error', (error) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolveFree();
      else reject(new Error('pool_model_port_unavailable'));
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('pool_model_port_unavailable'));
    });
  });
}

// FLAG: CPU capacity is advertised only after the exact installed production prompt has
// populated its prefix cache. A generic readiness prompt leaves long first inputs too slow.
export async function warmPoolCpuModel(nodeId, key, signal, protocol, readJson = poolJson) {
  if (
    protocol.commercialLlmPromptSha256(poolProfile(nodeId).identity.chatTemplateSha256) !==
    poolProfile(nodeId).identity.promptSha256
  )
    throw new Error('pool_primer_identity');
  const body = protocol.buildCommercialLlmRequest('Обычное обсуждение погоды в нашем городе.');
  const response = await readJson('/v1/chat/completions', key, {
    nodeId,
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    body: JSON.stringify({ ...body, model: poolProfile(nodeId).identity.modelAlias }),
  });
  const choice = response?.choices?.[0];
  const message = choice?.message;
  let decision;
  try {
    decision = protocol.parseCommercialLlmDecision(JSON.parse(message?.content));
  } catch {
    throw new Error('pool_primer_decision');
  }
  if (
    response?.model !== poolProfile(nodeId).identity.modelAlias ||
    response.choices.length !== 1 ||
    choice.finish_reason !== 'stop' ||
    message?.role !== 'assistant' ||
    message.reasoning_content ||
    message.reasoning ||
    message.refusal ||
    message.tool_calls?.length ||
    !decision
  )
    throw new Error('pool_primer_decision');
}

async function warmModel(nodeId, key, signal, bundle) {
  if (poolProfile(nodeId).device === 'cpu') {
    const protocol = await import(pathToFileURL(join(bundle, primerName)).href);
    return warmPoolCpuModel(nodeId, key, signal, protocol);
  }
  const response = await poolJson('/v1/chat/completions', key, {
    nodeId,
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    body: JSON.stringify({
      model: poolProfile(nodeId).identity.modelAlias,
      messages: [{ role: 'user', content: 'Return the requested readiness JSON.' }],
      temperature: 0,
      seed: 0,
      max_tokens: 32,
      stream: false,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'local_readiness',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['ready'],
            properties: { ready: { type: 'boolean', const: true } },
          },
        },
      },
    }),
  });
  const choice = response.choices?.[0];
  if (
    response.model !== poolProfile(nodeId).identity.modelAlias ||
    response.choices?.length !== 1 ||
    choice?.finish_reason !== 'stop' ||
    choice?.message?.role !== 'assistant' ||
    JSON.parse(choice?.message?.content ?? 'null')?.ready !== true
  )
    throw new Error('pool_warmup_failed');
}

export function createPoolController(nodeId, { taskHome = homedir() } = {}) {
  const profile = poolProfile(nodeId);
  const root = join(taskHome, '.local/share/maxim-llm-pool', nodeId);
  const state = join(root, 'service');
  const running = () => readPoolProcess(state, nodeId);
  const installation = () => {
    privateDirectory(root);
    privateDirectory(state);
    privateFile(join(state, 'installation.json'));
    const installed = JSON.parse(readFileSync(join(state, 'installation.json'), 'utf8'));
    if (
      installed.nodeId !== nodeId ||
      !poolIdentityMatches(nodeId, installed.identity) ||
      typeof installed.bundle !== 'string' ||
      !resolve(installed.bundle).startsWith(join(state, 'bundles') + sep) ||
      !isAbsolute(installed.node)
    )
      throw new Error('pool_installation_refused');
    poolSshArgs(nodeId, installed.sshAlias);
    return installed;
  };

  const install = async ({ artifactDirectory = root, sshAlias = 'maxim-vps' } = {}) => {
    if (running()) throw new Error('pool_stop_before_install');
    poolSshArgs(nodeId, sshAlias);
    mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
    privateDirectory(dirname(root));
    mkdirSync(root, { recursive: true, mode: 0o700 });
    privateDirectory(root);
    chmodSync(root, 0o700);
    mkdirSync(state, { recursive: true, mode: 0o700 });
    privateDirectory(state);
    chmodSync(state, 0o700);
    for (const artifact of profile.artifacts) {
      await checkArtifact(artifactDirectory, artifact);
      if (resolve(artifactDirectory) !== root) {
        const target = join(root, artifact.name);
        if (!existsSync(target)) {
          const temporary = `${target}.${process.pid}.tmp`;
          copyFileSync(join(artifactDirectory, artifact.name), temporary);
          chmodSync(temporary, 0o600);
          renameSync(temporary, target);
        }
        await checkArtifact(root, artifact);
      }
    }
    const source = dirname(fileURLToPath(import.meta.url));
    const bundleHash = createHash('sha256');
    for (const name of scriptNames) bundleHash.update(readFileSync(join(source, name)));
    if (profile.device === 'cpu') bundleHash.update(readFileSync(join(source, primerSource)));
    const bundle = join(state, 'bundles', bundleHash.digest('hex'));
    if (!existsSync(bundle)) {
      mkdirSync(dirname(bundle), { recursive: true, mode: 0o700 });
      const staging = mkdtempSync(join(dirname(bundle), '.preparing-'));
      for (const name of scriptNames) copyFileSync(join(source, name), join(staging, name));
      if (profile.device === 'cpu')
        copyFileSync(join(source, primerSource), join(staging, primerName));
      const runtime = join(staging, 'runtime');
      mkdirSync(runtime, { mode: 0o700 });
      for (const artifact of profile.artifacts.slice(1))
        execFileSync(
          'tar',
          [
            '--extract',
            '--gzip',
            '--no-same-owner',
            '--file',
            join(root, artifact.name),
            '--directory',
            runtime,
          ],
          { timeout: 60_000, stdio: 'ignore' },
        );
      const files = {};
      for (const name of walkFiles(staging))
        files[name] = lstatSync(join(staging, name)).isSymbolicLink()
          ? { target: readlinkSync(join(staging, name)) }
          : { sha256: await hash(join(staging, name)) };
      atomic(join(staging, 'files.json'), files);
      renameSync(staging, bundle);
    }
    await verifyBundle(bundle);
    const keyPath = join(state, 'api-key');
    if (!existsSync(keyPath))
      writeFileSync(keyPath, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
    privateFile(keyPath);
    atomic(join(state, 'installation.json'), {
      nodeId,
      bundle,
      node: process.execPath,
      sshAlias,
      identity: profile.identity,
    });
    const bin = join(taskHome, '.local/bin');
    mkdirSync(bin, { recursive: true });
    const launcher = join(bin, `maxim-llm-${nodeId}`);
    const marker = `# MAXIM pool workstation launcher ${nodeId}`;
    if (existsSync(launcher) && !readFileSync(launcher, 'utf8').includes(marker))
      throw new Error('pool_foreign_launcher_refused');
    atomic(
      launcher,
      `#!/bin/sh\n${marker}\noperation=\${1:-status}\nif [ "$#" -gt 0 ]; then shift; fi\nexec ${shellQuote(process.execPath)} ${shellQuote(join(bundle, scriptNames[0]))} "$operation" ${shellQuote(nodeId)} "$@"\n`,
    );
    chmodSync(launcher, 0o700);
    return { installed: true, nodeId, launcher, bundle, model: profile.identity.modelAlias };
  };

  const status = () => {
    const current = running();
    return current
      ? {
          running: true,
          ...current,
          enabled: poolResumeEnabled(state),
          heartbeatFresh: Date.now() - Date.parse(current.heartbeatAt) < 6000,
        }
      : { running: false, nodeId, enabled: poolResumeEnabled(state) };
  };

  const stop = async () => {
    if (existsSync(join(state, 'enabled'))) unlinkSync(join(state, 'enabled'));
    const current = running();
    if (current) process.kill(current.pid, 'SIGTERM');
    const deadline = Date.now() + 12_000;
    while (running() && Date.now() < deadline) await pause(100);
    if (running()) throw new Error('pool_supervisor_stop_deadline');
    return { stopped: true, nodeId };
  };

  const start = async ({ resume = false } = {}) => {
    if (resume && !poolResumeEnabled(state)) return { started: false, disabled: true, nodeId };
    const installed = installation();
    atomic(join(state, 'enabled'), '1\n');
    if (!running()) {
      const child = spawn(
        '/usr/bin/flock',
        [
          '--nonblock',
          '--close',
          join(state, 'supervisor.lock'),
          '/usr/bin/python3',
          '-c',
          childGuard,
          installed.node,
          join(installed.bundle, scriptNames[0]),
          'run',
          nodeId,
        ],
        {
          detached: true,
          stdio: 'ignore',
          env: { PATH: '/usr/bin:/bin', HOME: taskHome, LANG: 'C.UTF-8' },
        },
      );
      child.on('error', () => undefined);
      child.unref();
      await pause(1000);
    }
    if (!running()) throw new Error('pool_supervisor_start_failed');
    return { started: true, nodeId };
  };

  // FLAG: Foreground lifetime lets Windows observe WSL failure. Shutdown never clears manual resume state.
  const watch = async () => {
    if (!poolResumeEnabled(state)) return { started: false, disabled: true, nodeId };
    const installed = installation();
    const controller = new AbortController();
    let child;
    const abort = () => {
      controller.abort();
      child?.kill('SIGTERM');
    };
    process.once('SIGTERM', abort);
    process.once('SIGINT', abort);
    try {
      while (!controller.signal.aborted && poolResumeEnabled(state)) {
        child = guardedPoolChild(
          '/usr/bin/flock',
          [
            '--nonblock',
            '--conflict-exit-code',
            '73',
            '--close',
            join(state, 'supervisor.lock'),
            '/usr/bin/python3',
            '-c',
            childGuard,
            installed.node,
            join(installed.bundle, scriptNames[0]),
            'run',
            nodeId,
          ],
          { stdio: 'ignore', env: { PATH: '/usr/bin:/bin', HOME: taskHome, LANG: 'C.UTF-8' } },
        );
        const result = await new Promise((resolveExit, rejectExit) => {
          child.once('error', rejectExit);
          child.once('close', (code) => resolveExit(code));
        });
        child = undefined;
        if (controller.signal.aborted || !poolResumeEnabled(state)) break;
        if (result !== 73) throw new Error('pool_foreground_supervisor_exited');
        await pause(2000, undefined, { signal: controller.signal }).catch(() => undefined);
      }
      return { stopped: true, nodeId };
    } finally {
      process.removeListener('SIGTERM', abort);
      process.removeListener('SIGINT', abort);
      await stopChild(child);
    }
  };

  const run = async () => {
    const { bundle, sshAlias } = installation();
    if (fileURLToPath(import.meta.url) !== join(bundle, scriptNames[0]))
      throw new Error('pool_installed_source_required');
    if (!poolResumeEnabled(state)) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once('SIGTERM', abort);
    process.once('SIGINT', abort);
    const startTicks = processStart(process.pid);
    let phase = 'verifying',
      lastSuccessAt = null,
      lastFailure = null,
      classifications = 0,
      model,
      ssh;
    const update = (value = phase) => {
      phase = value;
      if (value === 'classified') {
        lastSuccessAt = new Date().toISOString();
        classifications++;
        phase = 'connected';
      }
      if (value === 'connected' || value === 'classified') lastFailure = null;
      atomic(join(state, 'status.json'), {
        pid: process.pid,
        startTicks,
        nodeId,
        bundle,
        phase,
        heartbeatAt: new Date().toISOString(),
        lastSuccessAt,
        lastFailure,
        classifications,
        modelPid: model?.pid ?? null,
        model: profile.identity.modelAlias,
      });
    };
    update();
    const heartbeat = setInterval(() => {
      if (!poolResumeEnabled(state)) abort();
      update();
    }, 2000);
    try {
      for (const artifact of profile.artifacts) await checkArtifact(root, artifact);
      await verifyBundle(bundle);
      const keyPath = join(state, 'api-key');
      privateFile(keyPath);
      const key = readFileSync(keyPath, 'utf8').trim();
      if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error('pool_api_key_refused');
      const runtime = join(bundle, 'runtime');
      const binary = join(runtime, 'llama-b11804/llama-server');
      const modelEnv = {
        PATH: '/usr/bin:/bin',
        HOME: root,
        LANG: 'C.UTF-8',
        LD_LIBRARY_PATH: [
          join(runtime, 'llama-b11804'),
          join(runtime, 'cudart-llama-b11804-bin-ubuntu-cuda-12.8-x64'),
          '/usr/lib/wsl/lib',
        ].join(':'),
        CUDA_CACHE_PATH: join(root, 'cuda-cache'),
        ...(profile.device === 'cpu'
          ? { CUDA_VISIBLE_DEVICES: '-1', OMP_NUM_THREADS: String(profile.threads) }
          : {}),
      };
      if (profile.device === 'cuda') {
        const devices = execFileSync(binary, ['--list-devices'], {
          env: modelEnv,
          encoding: 'utf8',
          timeout: 15_000,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        if (!/CUDA\d+:/u.test(devices)) throw new Error('pool_cuda_unavailable');
      }
      let retry = 0;
      while (!controller.signal.aborted) {
        try {
          if (!model) {
            await assertFreeModelPort(nodeId);
            update('loading');
            const args = poolModelArgs(nodeId, root, keyPath);
            model = guardedPoolChild(
              profile.device === 'cpu' ? '/usr/bin/nice' : binary,
              profile.device === 'cpu' ? ['-n', '10', binary, ...args] : args,
              {
                env: modelEnv,
                stdio: 'ignore',
              },
            );
            let spawnFailed = false;
            model.once('error', () => {
              spawnFailed = true;
            });
            const deadline = Date.now() + 120_000;
            let ready = false;
            while (!ready && Date.now() < deadline && !controller.signal.aborted) {
              if (spawnFailed || model.exitCode !== null || model.signalCode !== null)
                throw new Error('pool_model_exit');
              try {
                await attestPoolModel(
                  nodeId,
                  key,
                  AbortSignal.any([controller.signal, AbortSignal.timeout(1500)]),
                );
                ready = true;
              } catch {
                await pause(500, undefined, { signal: controller.signal });
              }
            }
            if (!ready) throw new Error('pool_model_start_deadline');
            update('warming');
            await warmModel(nodeId, key, controller.signal, bundle);
          }
          update('connecting');
          ssh = await connectPoolTransport(model, {
            nodeId,
            key,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1500)]),
            connect: () =>
              guardedPoolChild('/usr/bin/ssh', poolSshArgs(nodeId, sshAlias), {
                stdio: ['pipe', 'pipe', 'ignore'],
                env: { PATH: '/usr/bin:/bin', HOME: taskHome, LANG: 'C.UTF-8' },
              }),
          });
          const modelExit = () => ssh?.kill('SIGTERM');
          model.once('exit', modelExit);
          try {
            await poolSession(ssh, nodeId, key, {
              signal: controller.signal,
              onStatus: (value) => {
                update(value);
                if (value === 'connected') retry = 0;
              },
            });
          } finally {
            model.removeListener('exit', modelExit);
          }
          if (model.exitCode !== null || model.signalCode !== null)
            throw new Error('pool_model_exit');
        } catch (error) {
          lastFailure = /^pool_[a-z0-9_]{1,64}$/u.test(error?.message)
            ? error.message
            : 'pool_unavailable';
          update(error?.recycleModel === false ? 'disconnected' : 'recovering');
          if (
            error?.recycleModel !== false ||
            !model ||
            model.exitCode !== null ||
            model.signalCode !== null
          ) {
            await stopChild(model);
            model = undefined;
          }
        } finally {
          await stopChild(ssh);
          ssh = undefined;
        }
        if (!controller.signal.aborted) {
          update('reconnecting');
          await pause(poolReconnectDelay(retry++), undefined, { signal: controller.signal }).catch(
            () => undefined,
          );
        }
      }
    } finally {
      controller.abort();
      clearInterval(heartbeat);
      await stopChild(ssh);
      await stopChild(model);
      model = undefined;
      update('stopped');
      process.removeListener('SIGTERM', abort);
      process.removeListener('SIGINT', abort);
    }
  };
  return { root, state, install, status, start, stop, run, watch };
}

async function cli() {
  const [operation, nodeId, ...extra] = process.argv.slice(2);
  if (process.platform !== 'linux') throw new Error('pool_linux_or_wsl_required');
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('pool_node24_required');
  if (!['install', 'start', 'resume', 'run', 'stop', 'status', 'watch'].includes(operation))
    throw new Error('pool_usage_install_start_resume_stop_status');
  const controller = createPoolController(nodeId);
  const options = {};
  if (operation === 'install') {
    while (extra.length) {
      const name = extra.shift();
      const value = extra.shift();
      if (!value) throw new Error('pool_install_option_refused');
      if (name === '--artifact-dir' && !options.artifactDirectory)
        options.artifactDirectory = resolve(value);
      else if (name === '--ssh-alias' && !options.sshAlias) options.sshAlias = value;
      else throw new Error('pool_install_option_refused');
    }
  } else if (extra.length) throw new Error('pool_extra_arguments');
  const result =
    operation === 'install'
      ? await controller.install(options)
      : operation === 'resume'
        ? await controller.start({ resume: true })
        : await controller[operation]();
  if (result !== undefined) console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  cli().catch(() => {
    process.stderr.write('pool_workstation_operation_failed\n');
    process.exitCode = 1;
  });
