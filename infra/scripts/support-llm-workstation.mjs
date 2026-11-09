#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WORKSTATION_ARTIFACTS } from './commercial-llm-workstation-profile.mjs';
import { SUPPORT_MODEL, supportModelArgs } from './support-llm-profile.mjs';
import {
  readSupportProvider,
  readSupportProviderKey,
  attestSupportApi,
} from './support-llm-provider.mjs';

const SCRIPT = 'support-llm-workstation.mjs';
const CHAT_SCRIPT = 'support-chat-worker.mjs';
const STARTUP_MS = 180_000;
const HEARTBEAT_MS = 2000;
const REQUIRED_FILES = [
  SCRIPT,
  'support-llm-profile.mjs',
  'support-llm-provider.mjs',
  'support-llm-client.mjs',
  'support-llm-routing.mjs',
  'support-llm-knowledge.json',
  'commercial-llm-workstation-profile.mjs',
];
const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const errorCode = (error) =>
  /^[a-z0-9_]{1,80}$/u.test(error?.message ?? '') ? error.message : 'support_operation_failed';

export async function supportFileHash(path, signal) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) digest.update(chunk);
  return digest.digest('hex');
}

export async function supportVerifyArtifact(path, expected, signal) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size !== expected.bytes ||
    (await supportFileHash(path, signal)) !== expected.sha256
  )
    throw new Error('support_artifact_identity');
}

export function supportPrivateFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077)
    throw new Error('support_private_file_required');
}

export function supportProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
    if (fields[0] === 'Z' || lstatSync(`/proc/${pid}`).uid !== process.getuid()) return null;
    return {
      pid,
      startTicks: fields[19],
      argv: readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean),
    };
  } catch {
    return null;
  }
}

export function supportMatchesProcess(
  record,
  expectedArgs,
  observed = supportProcessIdentity(record?.pid),
) {
  return Boolean(
    observed &&
    record &&
    Number.isSafeInteger(record.pid) &&
    record.pid > 1 &&
    typeof record.startTicks === 'string' &&
    /^\d+$/u.test(record.startTicks) &&
    observed.pid === record.pid &&
    observed.startTicks === record.startTicks &&
    JSON.stringify(observed.argv) === JSON.stringify(expectedArgs),
  );
}

function atomic(path, value) {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temporary, typeof value === 'string' ? value : JSON.stringify(value) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  renameSync(temporary, path);
}

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid())
    throw new Error('support_directory_refused');
  chmodSync(path, 0o700);
}

function walkFiles(directory, base = directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return walkFiles(path, base);
      if (!entry.isFile() && !entry.isSymbolicLink())
        throw new Error('support_bundle_entry_refused');
      return [path.slice(base.length + 1)];
    })
    .sort();
}

export async function supportVerifyBundle(bundle, manifestSha256) {
  const manifest = join(bundle, 'files.json');
  if (
    lstatSync(bundle).isSymbolicLink() ||
    lstatSync(manifest).isSymbolicLink() ||
    (manifestSha256 && (await supportFileHash(manifest)) !== manifestSha256)
  )
    throw new Error('support_bundle_manifest_changed');
  const files = JSON.parse(readFileSync(manifest, 'utf8'));
  if (!files || Array.isArray(files) || typeof files !== 'object')
    throw new Error('support_bundle_manifest_invalid');
  const actual = walkFiles(bundle).filter((name) => name !== 'files.json');
  if (JSON.stringify(actual) !== JSON.stringify(Object.keys(files).sort()))
    throw new Error('support_bundle_files_changed');
  for (const [name, expected] of Object.entries(files)) {
    const path = join(bundle, name),
      stat = lstatSync(path);
    if (typeof expected.target === 'string') {
      if (
        !stat.isSymbolicLink() ||
        readlinkSync(path) !== expected.target ||
        !resolve(dirname(path), expected.target).startsWith(bundle + '/')
      )
        throw new Error('support_bundle_link_changed');
    } else if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (await supportFileHash(path)) !== expected.sha256
    )
      throw new Error('support_bundle_file_changed');
  }
}

function installationRecord(installed, state, requireCurrentModel = true) {
  if (
    installed?.version !== 1 ||
    typeof installed.bundle !== 'string' ||
    dirname(installed.bundle) !== join(state, 'bundles') ||
    !/^[a-f0-9]{64}$/u.test(installed.bundle.slice(installed.bundle.lastIndexOf('/') + 1)) ||
    !/^[a-f0-9]{64}$/u.test(installed.manifestSha256 ?? '') ||
    !/^[a-f0-9]{64}$/u.test(installed.modelSha256 ?? '') ||
    installed.node !== process.execPath ||
    (requireCurrentModel && installed.modelSha256 !== SUPPORT_MODEL.sha256)
  )
    throw new Error('support_installation_identity');
  return installed;
}

export async function supportPreviousModelArgs(installed, root, keyFile) {
  installationRecord(installed, join(root, 'service'), false);
  // FLAG: Only a verified prior bundle may describe its model during upgrade or rollback.
  // Ordinary runtime operations still require the current profile's exact model identity.
  await supportVerifyBundle(installed.bundle, installed.manifestSha256);
  const profile = await import(
    pathToFileURL(join(installed.bundle, 'support-llm-profile.mjs')).href
  );
  if (
    profile.SUPPORT_MODEL?.sha256 !== installed.modelSha256 ||
    typeof profile.supportModelArgs !== 'function'
  )
    throw new Error('support_previous_model_profile');
  const args = profile.supportModelArgs(root, keyFile);
  if (!Array.isArray(args) || !args.length || args.some((arg) => typeof arg !== 'string'))
    throw new Error('support_previous_model_profile');
  return [join(installed.bundle, 'runtime/llama-b11804/llama-server'), ...args];
}

async function modelJson(path, key, signal, fetchImpl, payload) {
  signal?.throwIfAborted();
  const response = await fetchImpl(new URL(path, SUPPORT_MODEL.endpoint), {
    headers: {
      Authorization: `Bearer ${key}`,
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { method: 'POST', body: JSON.stringify(payload) }),
    signal,
    redirect: 'error',
  });
  if (
    !response.ok ||
    !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '') ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new Error('support_model_http');
  }
  const reader = response.body.getReader(),
    chunks = [];
  const abortRead = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal?.addEventListener('abort', abortRead, { once: true });
  let length = 0;
  try {
    signal?.throwIfAborted();
    for (;;) {
      const item = await reader.read();
      signal?.throwIfAborted();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > 128 * 1024) throw new Error('support_model_output_limit');
      chunks.push(item.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    signal?.removeEventListener('abort', abortRead);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function attestSupportModel(key, signal, fetchImpl = fetch) {
  const health = await modelJson('/health', key, signal, fetchImpl);
  if (health.status !== 'ok') throw new Error('support_model_not_ready');
  const models = await modelJson('/v1/models', key, signal, fetchImpl);
  if (
    !Array.isArray(models.data) ||
    models.data.length !== 1 ||
    models.data[0].id !== SUPPORT_MODEL.alias
  )
    throw new Error('support_model_identity');
  const props = await modelJson('/props', key, signal, fetchImpl);
  if (
    props.total_slots !== 1 ||
    typeof props.chat_template !== 'string' ||
    !props.chat_template.length ||
    (props.default_generation_settings?.n_ctx !== undefined &&
      props.default_generation_settings.n_ctx !== SUPPORT_MODEL.context)
  )
    throw new Error('support_model_profile');
}

export async function warmSupportModel(key, signal, fetchImpl = fetch) {
  // FLAG: The supervisor verifies its immutable bundle before importing this warmup producer.
  // Warmup content is discarded; completion success alone never becomes a public answer.
  const { supportWarmupPayload } = await import('./support-llm-client.mjs');
  const result = await modelJson(
    '/v1/chat/completions',
    key,
    signal,
    fetchImpl,
    supportWarmupPayload(),
  );
  if (
    result?.model !== SUPPORT_MODEL.alias ||
    !Array.isArray(result.choices) ||
    result.choices.length !== 1 ||
    !['length', 'stop'].includes(result.choices[0]?.finish_reason) ||
    !Number.isSafeInteger(result.usage?.prompt_tokens) ||
    result.usage.prompt_tokens <= 0 ||
    !Number.isSafeInteger(result.usage?.completion_tokens) ||
    result.usage.completion_tokens < 0 ||
    result.usage.completion_tokens > 1
  )
    throw new Error('support_model_warmup');
}

// FLAG: The child retains parent-death containment after nice execs the CPU-only model binary.
const childGuard = `import ctypes,os,signal,sys
parent=os.getppid()
if ctypes.CDLL(None).prctl(1,signal.SIGTERM,0,0,0)!=0: sys.exit(70)
if os.getppid()!=parent or parent==1: sys.exit(71)
os.execvpe(sys.argv[1],sys.argv[1:],os.environ)`;

async function stopChild(child, expectedArgs, startTicks) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const owned = () => {
    const observed = supportProcessIdentity(child.pid);
    return (
      observed?.startTicks === startTicks &&
      [
        expectedArgs,
        ['/usr/bin/nice', '-n', '10', ...expectedArgs],
        ['/usr/bin/python3', '-c', childGuard, '/usr/bin/nice', '-n', '10', ...expectedArgs],
      ].some((args) => supportMatchesProcess({ pid: child.pid, startTicks }, args, observed))
    );
  };
  let done = false;
  const closed = new Promise((resolveClosed) =>
    child.once('close', () => {
      done = true;
      resolveClosed();
    }),
  );
  if (owned()) child.kill('SIGTERM');
  await Promise.race([closed, pause(3000)]);
  if (!done && owned()) child.kill('SIGKILL');
  if (!done) await Promise.race([closed, pause(2000)]);
  if (!done && owned()) throw new Error('support_child_stop_deadline');
}

export function createSupportController({
  root = join(homedir(), '.local/share/maxim-support-llm'),
  gpuRoot = join(homedir(), '.local/share/maxim-llm'),
  bin = join(homedir(), '.local/bin'),
  source = dirname(fileURLToPath(import.meta.url)),
} = {}) {
  const state = join(root, 'service');
  const keyPath = join(state, 'api-key');
  const modelPath = join(root, SUPPORT_MODEL.filename);
  const scriptPath = (bundle, chat = false) => join(bundle, chat ? CHAT_SCRIPT : SCRIPT);
  const statusPath = (chat) => join(state, chat ? 'chat-status.json' : 'status.json');
  const enabledPath = (chat) => join(state, chat ? 'chat-enabled' : 'enabled');
  const binaryPath = (bundle) => join(bundle, 'runtime/llama-b11804/llama-server');
  const modelArgs = (bundle) => [binaryPath(bundle), ...supportModelArgs(root, keyPath)];
  function installation(requireCurrentModel = true) {
    const path = join(state, 'installation.json');
    supportPrivateFile(path);
    const installed = JSON.parse(readFileSync(path, 'utf8'));
    return installationRecord(installed, state, requireCurrentModel);
  }
  function readStatus(chat = false) {
    try {
      supportPrivateFile(statusPath(chat));
      return JSON.parse(readFileSync(statusPath(chat), 'utf8'));
    } catch {
      return null;
    }
  }
  function running(installed, chat = false) {
    const record = readStatus(chat);
    return record?.bundle === installed.bundle &&
      supportMatchesProcess(record, [installed.node, scriptPath(installed.bundle, chat), 'run'])
      ? record
      : null;
  }
  const modelOwned = (record, installed) =>
    supportMatchesProcess(
      { pid: record?.modelPid, startTicks: record?.modelStartTicks },
      modelArgs(installed.bundle),
    );
  function assertPreviousStopped(installed, previousModelArgs) {
    const previousStatus = readStatus();
    if (
      running(installed) ||
      running(installed, true) ||
      supportMatchesProcess(
        { pid: previousStatus?.modelPid, startTicks: previousStatus?.modelStartTicks },
        previousModelArgs,
      )
    )
      throw new Error('support_stop_before_install');
  }
  function key() {
    supportPrivateFile(keyPath);
    const value = readFileSync(keyPath, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error('support_api_key_refused');
    return value;
  }
  async function artifactChecks(signal) {
    const artifacts = [
      { path: modelPath, bytes: SUPPORT_MODEL.bytes, sha256: SUPPORT_MODEL.sha256 },
      ...WORKSTATION_ARTIFACTS.slice(1).map((artifact) => ({
        ...artifact,
        path: join(gpuRoot, artifact.name),
      })),
    ];
    for (const artifact of artifacts) await supportVerifyArtifact(artifact.path, artifact, signal);
  }
  async function install() {
    privateDirectory(root);
    privateDirectory(state);
    let previous = null,
      previousModelArgs;
    if (existsSync(join(state, 'installation.json'))) {
      previous = installation(false);
      previousModelArgs = await supportPreviousModelArgs(previous, root, keyPath);
      assertPreviousStopped(previous, previousModelArgs);
    }
    await artifactChecks();
    const names = [
      ...REQUIRED_FILES,
      ...(existsSync(join(source, CHAT_SCRIPT)) ? [CHAT_SCRIPT] : []),
    ].sort();
    const digest = createHash('sha256');
    for (const name of names) {
      const path = join(source, name);
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
        throw new Error('support_source_file_refused');
      digest
        .update(name + '\0')
        .update(readFileSync(path))
        .update('\0');
    }
    for (const artifact of WORKSTATION_ARTIFACTS.slice(1)) digest.update(artifact.sha256);
    const bundle = join(state, 'bundles', digest.digest('hex'));
    privateDirectory(dirname(bundle));
    if (!existsSync(bundle)) {
      const staging = mkdtempSync(join(dirname(bundle), '.preparing-'));
      try {
        for (const name of names) copyFileSync(join(source, name), join(staging, name));
        const runtime = join(staging, 'runtime');
        mkdirSync(runtime, { mode: 0o700 });
        for (const artifact of WORKSTATION_ARTIFACTS.slice(1))
          execFileSync(
            'tar',
            [
              '--extract',
              '--gzip',
              '--no-same-owner',
              '--file',
              join(gpuRoot, artifact.name),
              '--directory',
              runtime,
            ],
            { timeout: 60_000, stdio: 'ignore' },
          );
        const files = {};
        for (const name of walkFiles(staging)) {
          const path = join(staging, name),
            stat = lstatSync(path);
          if (stat.isSymbolicLink()) {
            const target = readlinkSync(path);
            if (!resolve(dirname(path), target).startsWith(staging + '/'))
              throw new Error('support_archive_link_refused');
            files[name] = { target };
          } else files[name] = { sha256: await supportFileHash(path) };
        }
        atomic(join(staging, 'files.json'), files);
        renameSync(staging, bundle);
      } finally {
        if (existsSync(staging)) rmSync(staging, { recursive: true });
      }
    }
    const previousManifest = previous?.bundle === bundle ? previous.manifestSha256 : undefined;
    await supportVerifyBundle(bundle, previousManifest);
    if (!existsSync(keyPath))
      writeFileSync(keyPath, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
    key();
    privateDirectory(bin);
    const launcher = join(bin, 'maxim-support');
    if (
      existsSync(launcher) &&
      (lstatSync(launcher).isSymbolicLink() ||
        !readFileSync(launcher, 'utf8').includes('# MAXIM CPU support launcher'))
    )
      throw new Error('support_foreign_launcher');
    if (previous) {
      if (JSON.stringify(installation(false)) !== JSON.stringify(previous))
        throw new Error('support_installation_changed');
      assertPreviousStopped(previous, previousModelArgs);
    } else if (existsSync(join(state, 'installation.json')))
      throw new Error('support_installation_changed');
    atomic(join(state, 'installation.json'), {
      version: 1,
      bundle,
      node: process.execPath,
      manifestSha256: await supportFileHash(join(bundle, 'files.json')),
      modelSha256: SUPPORT_MODEL.sha256,
    });
    atomic(
      launcher,
      `#!/bin/sh\n# MAXIM CPU support launcher\nexec ${shellQuote(process.execPath)} ${shellQuote(scriptPath(bundle))} "$@"\n`,
    );
    chmodSync(launcher, 0o700);
    return { installed: true, launcher, bundle, model: SUPPORT_MODEL.alias };
  }
  async function status(chat = false) {
    if (!existsSync(join(state, 'installation.json')))
      return { installed: false, running: false, ready: false };
    const installed = installation(),
      current = running(installed, chat);
    if (!current) {
      const last = readStatus(chat);
      return {
        installed: true,
        running: false,
        ready: false,
        ...(last
          ? {
              phase: last.phase,
              heartbeatAt: last.heartbeatAt,
              failureCode: last.failureCode ?? null,
              ...(chat
                ? {
                    lastFailureCode: last.lastFailureCode ?? null,
                    lastFailureAt: last.lastFailureAt ?? null,
                    lastDisconnectCode: last.lastDisconnectCode ?? null,
                    lastDisconnectAt: last.lastDisconnectAt ?? null,
                    chats: last.chats ?? null,
                    chatIds: last.chatIds ?? null,
                  }
                : {}),
            }
          : {}),
      };
    }
    const age = Date.now() - Date.parse(current.heartbeatAt);
    const heartbeatFresh =
      Number.isFinite(age) && age >= 0 && age < (chat ? 15_000 : HEARTBEAT_MS * 3);
    let ready = false;
    if (chat) {
      const { supportChatsReady } = await import('./support-chat-worker.mjs');
      ready =
        ['connected', 'answering'].includes(current.phase) && supportChatsReady(current.chats);
    }
    const ownsModel = chat ? undefined : modelOwned(current, installed);
    if (!chat && ownsModel && current.phase === 'ready' && heartbeatFresh) {
      try {
        await attestSupportModel(key(), AbortSignal.timeout(1500));
        ready = true;
      } catch {
        /* No content in health state. */
      }
    }
    return {
      installed: true,
      running: true,
      ...current,
      heartbeatFresh,
      ...(chat ? {} : { modelOwned: ownsModel }),
      ready: Boolean(ready && heartbeatFresh),
    };
  }
  async function stop(chat = false) {
    if (existsSync(enabledPath(chat))) unlinkSync(enabledPath(chat));
    if (!existsSync(join(state, 'installation.json'))) return { stopped: true };
    const installed = installation(),
      current = running(installed, chat);
    if (current && running(installed, chat)?.pid === current.pid)
      process.kill(current.pid, 'SIGTERM');
    const deadline = Date.now() + 12_000;
    while (running(installed, chat) && Date.now() < deadline) await pause(100);
    if (running(installed, chat)) throw new Error('support_supervisor_stop_deadline');
    if (!chat && current && modelOwned(current, installed)) {
      process.kill(current.modelPid, 'SIGTERM');
      const modelDeadline = Date.now() + 5000;
      while (modelOwned(current, installed) && Date.now() < modelDeadline) await pause(100);
      if (modelOwned(current, installed)) process.kill(current.modelPid, 'SIGKILL');
      await pause(100);
      if (modelOwned(current, installed)) throw new Error('support_model_stop_deadline');
    }
    return { stopped: true };
  }
  async function start(chat = false) {
    const installed = installation();
    if (chat && !existsSync(scriptPath(installed.bundle, true)))
      throw new Error('support_chat_worker_not_installed');
    const provider = chat ? readSupportProvider(root) : null;
    if (provider?.backend === 'api')
      await attestSupportApi(readSupportProviderKey(provider), AbortSignal.timeout(20_000));
    else if (chat && !(await status()).ready) throw new Error('support_model_not_ready');
    await supportVerifyBundle(installed.bundle, installed.manifestSha256);
    if (provider?.backend !== 'api') key();
    atomic(enabledPath(chat), '1\n');
    if (!running(installed, chat)) {
      const child = spawn(
        '/usr/bin/flock',
        [
          '--nonblock',
          '--close',
          join(state, chat ? 'chat.lock' : 'supervisor.lock'),
          installed.node,
          scriptPath(installed.bundle, chat),
          'run',
        ],
        {
          detached: true,
          stdio: 'ignore',
          env: { PATH: '/usr/bin:/bin', HOME: homedir(), LANG: 'C.UTF-8' },
        },
      );
      let spawnFailed = false;
      child.on('error', () => {
        spawnFailed = true;
      });
      child.unref();
      const deadline = Date.now() + STARTUP_MS;
      while (Date.now() < deadline) {
        if (spawnFailed) throw new Error('support_supervisor_spawn_failed');
        const current = running(installed, chat);
        if (current) {
          if (['failed', 'stopped'].includes(current.phase))
            throw new Error(current.failureCode ?? 'support_supervisor_start_failed');
          if ((await status(chat)).ready) return { started: true, ready: true, pid: current.pid };
        } else if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error('support_supervisor_start_failed');
        }
        await pause(500);
      }
      await stop(chat);
      throw new Error('support_start_deadline');
    }
    const current = await status(chat);
    return { started: true, ready: current.ready, pid: current.pid, phase: current.phase };
  }
  async function run() {
    const installed = installation();
    if (resolve(process.argv[1]) !== scriptPath(installed.bundle))
      throw new Error('support_installed_source_required');
    if (!existsSync(enabledPath(false))) return;
    const abort = new AbortController(),
      started = Date.now(),
      identity = supportProcessIdentity(process.pid);
    let phase = 'verifying',
      model,
      modelStartTicks = null,
      failureCode = null,
      lastSuccessAt = null;
    const stopRequested = () => abort.abort();
    const publish = () =>
      atomic(statusPath(false), {
        pid: process.pid,
        startTicks: identity.startTicks,
        bundle: installed.bundle,
        phase,
        heartbeatAt: new Date().toISOString(),
        lastSuccessAt,
        modelPid: model?.pid ?? null,
        modelStartTicks,
        model: SUPPORT_MODEL.alias,
        modelSha256: SUPPORT_MODEL.sha256,
        execution: 'CPU',
        failureCode,
      });
    process.once('SIGTERM', stopRequested);
    process.once('SIGINT', stopRequested);
    publish();
    const heartbeat = setInterval(() => {
      if (!existsSync(enabledPath(false))) stopRequested();
      publish();
    }, HEARTBEAT_MS);
    const startupTimer = setTimeout(() => {
      failureCode = 'support_start_deadline';
      abort.abort();
    }, STARTUP_MS);
    const expectedArgs = modelArgs(installed.bundle);
    try {
      await artifactChecks(abort.signal);
      await supportVerifyBundle(installed.bundle, installed.manifestSha256);
      const apiKey = key();
      if (abort.signal.aborted || Date.now() - started >= STARTUP_MS)
        throw new Error('support_start_deadline');
      phase = 'loading';
      publish();
      const runtime = join(installed.bundle, 'runtime');
      model = spawn(
        '/usr/bin/python3',
        ['-c', childGuard, '/usr/bin/nice', '-n', '10', ...expectedArgs],
        {
          stdio: 'ignore',
          env: {
            PATH: '/usr/bin:/bin',
            LANG: 'C.UTF-8',
            CUDA_VISIBLE_DEVICES: '',
            GGML_VK_VISIBLE_DEVICES: '',
            LD_LIBRARY_PATH: [
              join(runtime, 'llama-b11804'),
              join(runtime, 'cudart-llama-b11804-bin-ubuntu-cuda-12.8-x64'),
              '/usr/lib/wsl/lib',
            ].join(':'),
          },
        },
      );
      let spawnFailed = false;
      model.on('error', () => {
        spawnFailed = true;
      });
      modelStartTicks = supportProcessIdentity(model.pid)?.startTicks ?? null;
      if (!modelStartTicks) throw new Error('support_model_spawn_identity');
      while (!abort.signal.aborted) {
        if (spawnFailed || model.exitCode !== null || model.signalCode !== null)
          throw new Error('support_model_exit');
        try {
          if (!modelOwned({ modelPid: model.pid, modelStartTicks }, installed))
            throw new Error('support_model_loading');
          await attestSupportModel(
            apiKey,
            AbortSignal.any([abort.signal, AbortSignal.timeout(1500)]),
          );
          break;
        } catch {
          await pause(500, undefined, { signal: abort.signal });
        }
      }
      abort.signal.throwIfAborted();
      // FLAG: One warmup shares the original startup deadline and must succeed before ready.
      phase = 'warming';
      publish();
      await warmSupportModel(apiKey, abort.signal);
      abort.signal.throwIfAborted();
      if (!modelOwned({ modelPid: model.pid, modelStartTicks }, installed))
        throw new Error('support_model_exit');
      phase = 'ready';
      lastSuccessAt = new Date().toISOString();
      publish();
      clearTimeout(startupTimer);
      let healthFailures = 0;
      while (!abort.signal.aborted) {
        await pause(2000, undefined, { signal: abort.signal });
        if (!modelOwned({ modelPid: model.pid, modelStartTicks }, installed))
          throw new Error('support_model_exit');
        try {
          await attestSupportModel(
            apiKey,
            AbortSignal.any([abort.signal, AbortSignal.timeout(1500)]),
          );
          lastSuccessAt = new Date().toISOString();
          healthFailures = 0;
        } catch {
          healthFailures++;
          if (healthFailures >= 3) throw new Error('support_model_health_failed');
        }
      }
    } catch (error) {
      if (!abort.signal.aborted || failureCode) failureCode ??= errorCode(error);
    } finally {
      clearTimeout(startupTimer);
      clearInterval(heartbeat);
      abort.abort();
      try {
        await stopChild(model, expectedArgs, modelStartTicks);
      } catch (error) {
        failureCode ??= errorCode(error);
      }
      model = undefined;
      phase = failureCode ? 'failed' : 'stopped';
      publish();
      process.removeListener('SIGTERM', stopRequested);
      process.removeListener('SIGINT', stopRequested);
    }
  }
  async function ask(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 1200)
      throw new Error('support_question_required');
    const installed = installation();
    const provider = readSupportProvider(root);
    if (provider.backend !== 'api' && !(await status()).ready)
      throw new Error('support_model_not_ready');
    await supportVerifyBundle(installed.bundle, installed.manifestSha256);
    const { answerSupport } = await import(
      pathToFileURL(join(installed.bundle, 'support-llm-client.mjs')).href
    );
    return answerSupport({
      text,
      key: readSupportProviderKey(provider),
      api: provider.backend === 'api',
    });
  }
  return { install, start, stop, status, run, ask };
}

async function cli() {
  const [operation = 'status', ...extra] = process.argv.slice(2),
    controller = createSupportController();
  if (operation === 'ask') {
    const result = await controller.ask(extra.join(' '));
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  if (
    extra.length ||
    ![
      'install',
      'start',
      'stop',
      'status',
      'run',
      'chat-start',
      'chat-stop',
      'chat-status',
    ].includes(operation)
  )
    throw new Error('support_usage_install_start_stop_status_ask');
  const chat = operation.startsWith('chat-'),
    method = operation.replace('chat-', '');
  const result = await controller[method](chat);
  if (result !== undefined) process.stdout.write(JSON.stringify(result) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  cli().catch((error) => {
    process.stderr.write(errorCode(error) + '\n');
    process.exitCode = 1;
  });
