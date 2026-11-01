import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { commercialLlmCommand, commercialLlmCommandSha256 } from './commercial-llm-profiles.mjs';
import {
  assertCommercialLlmContainer,
  assertCommercialLlmTemplate,
  assertCommercialLlmTransition,
  replaceCommercialLlmGeneration,
  COMMERCIAL_LLM_LEGACY_RUNTIME as legacyPin,
  COMMERCIAL_LLM_SLOTS_RUNTIME as slotsPin,
  assertCommercialLlmImage,
  assertCommercialLlmReceipt,
  assertCommercialLlmIdleSlots,
  parseCommercialLlmModelJson,
  assertCommercialLlmSlotsTransition,
  commercialLlmReceiptProfile,
  commercialLlmContainerProfile,
  commercialLlmCreationOverride,
  upgradeCommercialLlmSlots,
  checkCommercialLlmCapacity,
  COMMERCIAL_LLM_RUNTIME as pin,
  commercialLlmSyntheticRequest,
  patchCommercialLlmEnvironment,
  reconcileCommercialLlmGeneration,
  validateCommercialLlmSyntheticResponse,
  validateCommercialLlmClientSmokeResponse,
  validateCommercialLlmClientSmokeFailure,
  executeCommercialLlmClientSmoke,
} from './commercial-llm-runtime.mjs';

const root = resolve(import.meta.dirname, '../..');
const compose = JSON.parse(
  execFileSync(
    'docker',
    [
      'compose',
      '--env-file',
      '.env.example',
      '-p',
      'infra',
      '-f',
      'infra/docker-compose.yml',
      '--profile',
      'commercial-llm',
      'config',
      '--format',
      'json',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, MAXIM_COMPOSE_SERVICE_ENV_FILE: '../.env.example' },
    },
  ),
);
const service = compose.services[pin.service];

test('attests the actual Docker 29 manifest identity and rejects its distinct OCI config digest', () => {
  const image = {
    Id: 'sha256:8badce92ec1860c764ca19c736422e81a12c65d76da57313651a7804bfe6ed40',
    Descriptor: {
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: 'sha256:8badce92ec1860c764ca19c736422e81a12c65d76da57313651a7804bfe6ed40',
      size: 1746,
    },
    Architecture: 'amd64',
    Os: 'linux',
    RepoDigests: [
      'ghcr.io/ggml-org/llama.cpp@sha256:8badce92ec1860c764ca19c736422e81a12c65d76da57313651a7804bfe6ed40',
    ],
    Config: {
      Labels: {
        'org.opencontainers.image.revision': 'c7fc5094179bf8a9c73c18593db714f8da41a402',
        'org.opencontainers.image.version': 'b11804',
      },
    },
  };
  assert.equal(assertCommercialLlmImage(image), image.Id);
  for (const mutate of [
    (value) => {
      value.Id = 'sha256:433c4af64d0e6218182ca6650fc5c4451afaa8aa0355b1c006f7474f8a1f6a92';
    },
    (value) => {
      value.Descriptor.digest = `sha256:${'0'.repeat(64)}`;
    },
    (value) => {
      value.Descriptor.mediaType = 'application/vnd.oci.image.index.v1+json';
    },
    (value) => {
      value.Architecture = 'arm64';
    },
    (value) => {
      value.Os = 'windows';
    },
    (value) => {
      value.RepoDigests = [];
    },
    (value) => {
      value.Config.Labels['org.opencontainers.image.revision'] = '0'.repeat(40);
    },
    (value) => {
      value.Config.Labels['org.opencontainers.image.version'] = 'unreviewed';
    },
  ]) {
    const invalid = structuredClone(image);
    mutate(invalid);
    assert.throws(() => assertCommercialLlmImage(invalid), /image_pin_refused/u);
  }
});

function container(profile = pin) {
  return {
    Id: 'a'.repeat(64),
    Image: pin.imageId,
    Config: {
      Image: service.image,
      User: service.user,
      Entrypoint: ['/app/llama-server'],
      Labels: {
        ...service.labels,
        'com.docker.compose.project': 'infra',
        'com.docker.compose.service': pin.service,
      },
      Env: [
        'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'LLAMA_ARG_HOST=0.0.0.0',
        'LLAMA_ARG_PORT=8080',
      ],
      Cmd: commercialLlmCommand(profile),
    },
    State: { Running: true, Health: { Status: 'healthy' } },
    HostConfig: {
      ReadonlyRootfs: service.read_only,
      Init: service.init,
      NanoCpus: service.cpus * 1e9,
      CpuShares: service.cpu_shares,
      Memory: Number(service.mem_limit),
      MemorySwap: Number(service.memswap_limit),
      PidsLimit: service.pids_limit,
      CapDrop: service.cap_drop,
      SecurityOpt: service.security_opt,
      PortBindings: {},
      Privileged: false,
      Tmpfs: { '/tmp': 'size=64m,mode=1777,uid=1000,gid=1000' },
    },
    NetworkSettings: { Networks: { infra_commercial_llm_internal: {} } },
    Mounts: service.volumes.map((mount) => ({
      Type: mount.type,
      Source: mount.source,
      Destination: mount.target,
      RW: !mount.read_only,
    })),
  };
}

test('production inference stays optional, private and limited to its single background client', () => {
  assert.deepEqual(service.profiles, ['commercial-llm']);
  assert.equal(service.image, pin.imageRef);
  assert.deepEqual(Object.keys(service.networks), ['commercial_llm_internal']);
  assert.equal(compose.networks.commercial_llm_internal.internal, true);
  assert.equal(service.ports, undefined);
  assert.equal(service.env_file, undefined);
  assert.equal(service.secrets, undefined);
  assert.equal(service.depends_on, undefined);
  assert.equal(service.cpus, 6);
  assert.equal(Number(service.mem_limit), 12 * 1024 ** 3);
  assert.equal(service.memswap_limit, service.mem_limit);
  const peers = Object.entries(compose.services)
    .filter(([, value]) => Object.hasOwn(value.networks ?? {}, 'commercial_llm_internal'))
    .map(([key]) => key)
    .sort();
  assert.deepEqual(peers, ['api-moderation-background', pin.service].sort());
  assert.equal(
    compose.services['api-moderation-background'].environment.COMMERCIAL_LLM_SHADOW_ENABLED,
    'false',
  );
  assert.equal(
    compose.services['api-moderation-background'].environment.COMMERCIAL_LLM_ENDPOINT,
    'http://gemma-commercial-shadow:8080',
  );
  assert.equal(assertCommercialLlmContainer(container()), 'a'.repeat(64));
  assert.deepEqual(service.command, commercialLlmCommand(pin));
  assert.equal(assertCommercialLlmContainer(container(slotsPin)), 'a'.repeat(64));
});

test('runtime attestation refuses wrong source, public exposure, secret inheritance and relaxed containment', () => {
  const defects = [
    (value) => {
      value.Image = `sha256:${'0'.repeat(64)}`;
    },
    (value) => {
      value.Config.Env.push('DATABASE_URL=redacted');
    },
    (value) => {
      value.HostConfig.NanoCpus = 8e9;
    },
    (value) => {
      value.HostConfig.MemorySwap = -1;
    },
    (value) => {
      value.HostConfig.PidsLimit = -1;
    },
    (value) => {
      value.HostConfig.ReadonlyRootfs = false;
    },
    (value) => {
      value.HostConfig.CapDrop = [];
    },
    (value) => {
      value.HostConfig.SecurityOpt = [];
    },
    (value) => {
      value.HostConfig.PortBindings = { '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] };
    },
    (value) => {
      value.NetworkSettings.Networks.infra_default = {};
    },
    (value) => {
      value.Mounts[0].RW = true;
    },
    (value) => {
      value.Mounts.push({
        Type: 'bind',
        Source: '/var/run/docker.sock',
        Destination: '/var/run/docker.sock',
        RW: true,
      });
    },
    (value) => {
      value.Config.Cmd = [...value.Config.Cmd, '--tools', 'all'];
    },
    (value) => {
      value.Config.Cmd = value.Config.Cmd.filter((arg) => arg !== '--no-agent');
    },
    (value) => {
      value.State.Health.Status = 'unhealthy';
    },
  ];
  for (const defect of defects) {
    const value = container();
    defect(value);
    assert.throws(() => assertCommercialLlmContainer(value), /runtime_attestation_refused/u);
  }
});

test('environment switch preserves unrelated dotenv bytes and refuses duplicate authority', () => {
  const original =
    '# literal values\nDATABASE_URL=not printed\nOTHER=value with spaces\nCOMMERCIAL_LLM_SHADOW_ENABLED=false\n';
  const enabled = patchCommercialLlmEnvironment(original, true);
  assert.equal(enabled, original.replace('SHADOW_ENABLED=false', 'SHADOW_ENABLED=true'));
  assert.equal(patchCommercialLlmEnvironment(enabled, true), enabled);
  assert.equal(patchCommercialLlmEnvironment(enabled, false), original);
  assert.equal(
    patchCommercialLlmEnvironment('A=x', true),
    'A=x\nCOMMERCIAL_LLM_SHADOW_ENABLED=true\n',
  );
  assert.throws(
    () =>
      patchCommercialLlmEnvironment(
        'COMMERCIAL_LLM_SHADOW_ENABLED=false\nexport COMMERCIAL_LLM_SHADOW_ENABLED=true\n',
        false,
      ),
    /duplicate/u,
  );
});

test('admission preserves the model download plus independent disk and memory reserves', () => {
  const enough = pin.modelBytes + pin.diskReserveBytes + pin.downloadReserveBytes + 100000;
  assert.equal(
    checkCommercialLlmCapacity({
      paths: [{ availableBytes: enough }, { availableBytes: enough }],
      availableMemoryBytes: pin.minimumAvailableMemoryBytes,
      needsDownload: true,
    }).artifactBytes,
    pin.modelBytes + pin.templateBytes + pin.licenseBytes,
  );
  assert.throws(
    () =>
      checkCommercialLlmCapacity({
        paths: [{ availableBytes: enough }, { availableBytes: pin.diskReserveBytes }],
        availableMemoryBytes: pin.minimumAvailableMemoryBytes,
        needsDownload: true,
      }),
    /disk_reserve/u,
  );
  assert.throws(
    () =>
      checkCommercialLlmCapacity({
        paths: [{ availableBytes: enough }, { availableBytes: enough }],
        availableMemoryBytes: pin.minimumAvailableMemoryBytes - 1,
        needsDownload: false,
      }),
    /memory_reserve/u,
  );
});

test('synthetic smoke is closed and checks complete bounded JSON, without asserting classifier quality', () => {
  const request = commercialLlmSyntheticRequest();
  assert.equal(request.model, pin.alias);
  assert.equal(request.stream, false);
  assert.equal(request.response_format.json_schema.strict, true);
  const valid = {
    choices: [
      {
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            classification: 'NOT_COMMERCIAL',
            reasonCodes: ['ORDINARY_DISCUSSION'],
          }),
        },
      },
    ],
  };
  assert.doesNotThrow(() => validateCommercialLlmSyntheticResponse(valid));
  for (const response of [
    {},
    { choices: [{ finish_reason: 'length', message: { content: '{}' } }] },
    {
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: '{"classification":"COMMERCIAL","reasonCodes":["ORDINARY_DISCUSSION"]}',
          },
        },
      ],
    },
    {
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content:
              '{"classification":"NOT_COMMERCIAL","reasonCodes":["ORDINARY_DISCUSSION"],"extra":true}',
          },
        },
      ],
    },
  ])
    assert.throws(() => validateCommercialLlmSyntheticResponse(response));
});

test('receipts retain exact model and upstream image provenance', () => {
  const receipt = {
    schemaVersion: 1,
    sourceSha: 'f'.repeat(40),
    installedAt: new Date().toISOString(),
    containerId: 'a'.repeat(64),
    state: 'installed',
    imageRef: pin.imageRef,
    imageId: pin.imageId,
    modelSha256: pin.modelSha256,
    modelBytes: pin.modelBytes,
    templateSha256: pin.templateSha256,
    modelManifestSha256: pin.modelManifestSha256,
    licenseSha256: pin.licenseSha256,
    upstreamRevision: pin.upstreamRevision,
    upstreamVersion: pin.upstreamVersion,
    cpuLimit: pin.cpuLimit,
    memoryLimitBytes: pin.memoryLimitBytes,
    contextTokens: 4096,
    parallelRequests: 1,
    generationThreads: pin.cpuLimit,
    reasoning: false,
    smoke: 'closed-synthetic-json-v1',
  };
  assert.equal(assertCommercialLlmReceipt(receipt), receipt);
  assert.throws(
    () => assertCommercialLlmReceipt({ ...receipt, modelSha256: '0'.repeat(64) }),
    /receipt_refused/u,
  );
  assert.throws(
    () => assertCommercialLlmReceipt({ ...receipt, imageRef: 'ghcr.io/ggml-org/llama.cpp:server' }),
    /receipt_refused/u,
  );
});

test('historical and slots generations require their exact command and receipt capability', () => {
  const historical = recoveryReceipt();
  const capable = {
    ...historical,
    runtimeProfile: slotsPin.runtimeProfile,
    commandSha256: commercialLlmCommandSha256(slotsPin),
  };
  assert.equal(commercialLlmReceiptProfile(historical), pin);
  assert.equal(commercialLlmReceiptProfile(capable), slotsPin);
  assertCommercialLlmReceipt(capable);
  assert.equal(commercialLlmContainerProfile(container()), pin);
  assert.equal(commercialLlmContainerProfile(container(slotsPin)), slotsPin);
  assert.throws(() => assertCommercialLlmReceipt(historical, slotsPin), /receipt_refused/u);
  assert.throws(() => assertCommercialLlmReceipt(capable, pin), /receipt_refused/u);
  assert.throws(() => assertCommercialLlmContainer(container(), { profile: slotsPin }));
  assert.throws(() => assertCommercialLlmContainer(container(slotsPin), { profile: pin }));
  for (const receipt of [
    { ...historical, runtimeProfile: slotsPin.runtimeProfile },
    { ...historical, commandSha256: commercialLlmCommandSha256(slotsPin) },
    { ...capable, runtimeProfile: 'unknown' },
    { ...capable, commandSha256: commercialLlmCommandSha256(pin) },
  ])
    assert.throws(() => assertCommercialLlmReceipt(receipt), /receipt_refused/u);
  assert.notEqual(commercialLlmCommandSha256(pin), commercialLlmCommandSha256(slotsPin));
  assert.equal(commercialLlmCommand(pin).includes('--no-slots'), true);
  assert.equal(commercialLlmCommand(legacyPin).includes('--no-slots'), true);
  assert.equal(commercialLlmCommand(slotsPin).includes('--slots'), true);
});

test('creation overrides contain only a fixed reviewed command and preserve old replacement semantics', () => {
  for (const profile of [pin, slotsPin]) {
    assert.deepEqual(JSON.parse(commercialLlmCreationOverride(profile)), {
      services: { [pin.service]: { command: commercialLlmCommand(profile) } },
    });
  }
  assert.throws(() => commercialLlmCreationOverride({ ...pin }), /creation_profile_refused/u);
  assert.throws(() => commercialLlmCreationOverride(legacyPin), /creation_profile_refused/u);
  for (const profile of [pin, slotsPin]) {
    const rendered = JSON.parse(
      execFileSync(
        'docker',
        [
          'compose',
          '--env-file',
          '.env.example',
          '-p',
          'infra',
          '-f',
          'infra/docker-compose.yml',
          '-f',
          '-',
          '--profile',
          'commercial-llm',
          'config',
          '--format',
          'json',
        ],
        {
          cwd: root,
          encoding: 'utf8',
          input: commercialLlmCreationOverride(profile),
          env: { ...process.env, MAXIM_COMPOSE_SERVICE_ENV_FILE: '../.env.example' },
        },
      ),
    );
    assert.deepEqual(rendered.services[pin.service], {
      ...service,
      command: commercialLlmCommand(profile),
    });
  }
});

test('model JSON parser never exposes malformed private slot text in errors or causes', () => {
  const marker = 'PRIVATE_SLOT_MARKER';
  assert.deepEqual(parseCommercialLlmModelJson('[{"id":0,"is_processing":false}]'), [
    { id: 0, is_processing: false },
  ]);
  for (const malformed of [marker, `[{"private":"${marker}"`, '{']) {
    assert.throws(
      () => parseCommercialLlmModelJson(malformed),
      (error) => {
        assert.equal(error.message, 'commercial_llm_model_json_refused');
        assert.equal(Object.hasOwn(error, 'cause'), false);
        assert.equal(`${error.message}\n${error.stack}`.includes(marker), false);
        return true;
      },
    );
  }
});

test('idle observation rejects health-shaped, busy, missing, malformed and multiple slots', () => {
  const idle = [{ id: 0, n_ctx: 4096, is_processing: false }];
  assert.equal(assertCommercialLlmIdleSlots(idle), idle);
  for (const value of [
    { status: 'ok' },
    null,
    [],
    [...idle, ...idle],
    [{}],
    [{ id: 0, n_ctx: 4096, is_processing: true }],
    [{ id: 0, n_ctx: 4096, is_processing: 'false' }],
    [{ id: 0, n_ctx: 4096 }],
    [{ id: 1, n_ctx: 4096, is_processing: false }],
    [{ id: 0, n_ctx: 2048, is_processing: false }],
  ])
    assert.throws(() => assertCommercialLlmIdleSlots(value), /idle_slots_unproved/u);
});

test('production mutators keep exact-green admission and the persistent protected lock', () => {
  const wrapper = readFileSync(resolve(root, 'infra/scripts/vps-connect.sh'), 'utf8');
  const host = readFileSync(resolve(root, 'infra/scripts/vps-commercial-llm.sh'), 'utf8');
  assert.match(wrapper, /node "\$ROOT_DIR\/scripts\/ci\/assert-green\.mjs" "\$target_sha"/u);
  assert.match(wrapper, /commercial-llm\)\s+commercial_llm "\$@"/u);
  assert.match(
    host,
    /acquire_deploy_lock[\s\S]+maxim_require_ordinary_effect_authority[\s\S]+require_deploy_lock/u,
  );
  assert.doesNotMatch(host, /FLUSH|prune|remove-orphans|force-recreate/u);
});

function recoveryReceipt(profile = pin) {
  return {
    schemaVersion: 1,
    sourceSha: 'f'.repeat(40),
    installedAt: new Date().toISOString(),
    containerId: 'a'.repeat(64),
    state: 'installed',
    imageRef: pin.imageRef,
    imageId: pin.imageId,
    modelSha256: pin.modelSha256,
    modelBytes: pin.modelBytes,
    modelManifestSha256: pin.modelManifestSha256,
    templateSha256: pin.templateSha256,
    licenseSha256: pin.licenseSha256,
    upstreamRevision: pin.upstreamRevision,
    upstreamVersion: pin.upstreamVersion,
    cpuLimit: pin.cpuLimit,
    memoryLimitBytes: pin.memoryLimitBytes,
    contextTokens: 4096,
    parallelRequests: 1,
    generationThreads: pin.cpuLimit,
    reasoning: false,
    smoke: 'closed-synthetic-json-v1',
    ...(profile === slotsPin
      ? {
          runtimeProfile: slotsPin.runtimeProfile,
          commandSha256: commercialLlmCommandSha256(slotsPin),
        }
      : {}),
  };
}

function replacementHarness(failure) {
  let current = container();
  current.Config.Labels['com.maxim.commercial-llm-model-sha256'] = legacyPin.modelSha256;
  current.Config.Cmd = commercialLlmCommand(legacyPin);
  current.HostConfig.NanoCpus = legacyPin.cpuLimit * 1e9;
  current.HostConfig.Memory = current.HostConfig.MemorySwap = legacyPin.memoryLimitBytes;
  current.Mounts = [
    [legacyPin.modelPath, legacyPin.modelContainerPath],
    [legacyPin.templatePath, '/models/chat_template.jinja'],
  ].map(([Source, Destination]) => ({ Type: 'bind', Source, Destination, RW: false }));
  let receipt = {
    ...recoveryReceipt(),
    ...Object.fromEntries(
      [
        'modelSha256',
        'modelBytes',
        'modelManifestSha256',
        'templateSha256',
        'licenseSha256',
        'cpuLimit',
        'memoryLimitBytes',
      ].map((key) => [key, legacyPin[key]]),
    ),
    generationThreads: legacyPin.cpuLimit,
  };
  let transition;
  let failed = false;
  const calls = [];
  const fail = (point) => {
    if (point === failure && !failed) {
      failed = true;
      throw new Error(`interrupted_${point}`);
    }
  };
  const io = {
    inspect: () => structuredClone(current),
    prepare: () => {
      calls.push('prepare');
      fail('prepare');
    },
    stop: (id) => {
      assert.equal(id, 'a'.repeat(64));
      calls.push('stop_old');
      current.State.Running = false;
      fail('stop');
    },
    remove: (id) => {
      assert.equal(id, 'a'.repeat(64));
      assert.equal(current.State.Running, false);
      calls.push('remove_old');
      current = null;
      fail('remove');
    },
    create: () => {
      assert.equal(current, null);
      calls.push('create_target');
      current = container();
      current.Id = 'b'.repeat(64);
      fail('create');
    },
    start: (id) => {
      assert.equal(id, current.Id);
      current.State.Running = true;
    },
    waitReady: (id) => {
      assert.equal(id, current.Id);
    },
    smoke: (id) => {
      assert.equal(id, current.Id);
      fail('smoke');
      calls.push('smoke_target');
      return structuredClone(current);
    },
    record: (value) => {
      calls.push('receipt');
      receipt = structuredClone(value);
      fail('receipt');
    },
    recordTransition: (value) => {
      calls.push(`journal_${value.phase}`);
      transition = structuredClone(value);
      fail(value.phase);
    },
  };
  return {
    io,
    calls,
    run: () =>
      replaceCommercialLlmGeneration({ sourceSha: 'f'.repeat(40), receipt, transition, io }),
    get receipt() {
      return receipt;
    },
    get transition() {
      return transition;
    },
    get current() {
      return current;
    },
  };
}

test('replacement journals the exact old receipt, stops it before target creation and attests before success', async () => {
  const h = replacementHarness();
  assert.equal((await h.run()).result, 'replaced');
  assert.deepEqual(h.calls, [
    'prepare',
    'journal_prepared',
    'stop_old',
    'remove_old',
    'create_target',
    'journal_started',
    'smoke_target',
    'receipt',
    'journal_complete',
  ]);
  assert.equal(h.receipt.modelSha256, pin.modelSha256);
  assert.equal(h.transition.previousReceipt.modelSha256, legacyPin.modelSha256);
  assert.equal(h.transition.targetContainerId, h.receipt.containerId);
  assert.equal((await h.run()).result, 'already_replaced');
  assert.equal(h.calls.filter((x) => x === 'create_target').length, 1);
});

test('a completed historical replacement refuses the slots command even with its old receipt and ID', async () => {
  const h = replacementHarness();
  await h.run();
  h.current.Config.Cmd = commercialLlmCommand(slotsPin);
  const calls = [...h.calls];
  await assert.rejects(h.run(), /runtime_attestation_refused/u);
  assert.deepEqual(h.calls, calls);
});

for (const boundary of [
  'prepare',
  'prepared',
  'stop',
  'remove',
  'create',
  'started',
  'smoke',
  'receipt',
  'complete',
]) {
  test(`interruption after ${boundary} resumes the captured transition without duplicate containers`, async () => {
    const h = replacementHarness(boundary);
    await assert.rejects(h.run(), /interrupted_/u);
    if (['prepare', 'prepared'].includes(boundary)) assert.equal(h.current.State.Running, true);
    if (boundary === 'smoke') assert.equal(h.receipt.modelSha256, legacyPin.modelSha256);
    await h.run();
    assert.equal(h.transition.phase, 'complete');
    assert.equal(h.current.Id, h.receipt.containerId);
    assert.equal(h.calls.filter((x) => x === 'remove_old').length, 1);
    assert.equal(h.calls.filter((x) => x === 'create_target').length, 1);
  });
}

test('replacement refuses foreign receipts, generations, containment and prepared-state drift', async () => {
  for (const mutate of [
    (h) => {
      h.receipt.containerId = 'e'.repeat(64);
    },
    (h) => {
      h.receipt.modelSha256 = '0'.repeat(64);
    },
    (h) => {
      h.current.HostConfig.PortBindings = { '8080/tcp': [] };
    },
    (h) => {
      h.current.HostConfig.NanoCpus = 8e9;
    },
    (h) => {
      h.io.prepare = () => {
        h.current.Id = 'e'.repeat(64);
      };
    },
  ]) {
    const h = replacementHarness();
    mutate(h);
    await assert.rejects(h.run());
    assert.equal(h.calls.includes('stop_old'), false);
    assert.equal(h.calls.includes('create_target'), false);
  }
  const h = replacementHarness('smoke');
  await assert.rejects(h.run(), /interrupted_smoke/u);
  h.current.Id = 'c'.repeat(64);
  await assert.rejects(h.run(), /generation_changed/u);
  assert.equal(h.receipt.modelSha256, legacyPin.modelSha256);
  assert.throws(
    () => assertCommercialLlmTransition(h.transition, 'e'.repeat(40)),
    /transition_refused/u,
  );
});

function slotsUpgradeHarness(failure) {
  let current = container();
  let receipt = recoveryReceipt();
  let transition;
  let previousTransition;
  let failed = false;
  const calls = [];
  const fail = (point) => {
    if (failure === point && !failed) {
      failed = true;
      throw new Error(`interrupted_${point}`);
    }
  };
  const io = {
    inspect: () => structuredClone(current),
    prepare: () => {
      calls.push('prepare');
      fail('prepare');
    },
    stop: (id) => {
      assert.equal(id, 'a'.repeat(64));
      calls.push('stop_old');
      current.State.Running = false;
      fail('stop');
    },
    remove: (id) => {
      assert.equal(id, 'a'.repeat(64));
      assert.equal(current.State.Running, false);
      calls.push('remove_old');
      current = null;
      fail('remove');
    },
    create: () => {
      assert.equal(current, null);
      calls.push('create_target');
      current = container(slotsPin);
      current.Id = 'b'.repeat(64);
      fail('create');
    },
    start: (id) => {
      assert.equal(id, current.Id);
      current.State.Running = true;
    },
    waitReady: (id) => {
      assert.equal(id, current.Id);
      fail('ready');
    },
    smoke: (id) => {
      assert.equal(id, current.Id);
      fail('smoke');
      calls.push('smoke_target');
      return structuredClone(current);
    },
    record: (value) => {
      calls.push('receipt');
      receipt = structuredClone(value);
      fail('receipt');
    },
    recordTransition: (value) => {
      assertCommercialLlmSlotsTransition(value, 'f'.repeat(40));
      calls.push(`journal_${value.phase}`);
      transition = structuredClone(value);
      fail(value.phase);
    },
  };
  return {
    io,
    calls,
    run: (options = {}) =>
      upgradeCommercialLlmSlots({
        sourceSha: 'f'.repeat(40),
        receipt,
        transition,
        previousTransition,
        io,
        apply: true,
        ...options,
      }),
    set previousTransition(value) {
      previousTransition = value;
    },
    get receipt() {
      return receipt;
    },
    get transition() {
      return transition;
    },
    get current() {
      return current;
    },
  };
}

test('slots preview attests the current generation without preparing, journaling or stopping it', async () => {
  const h = slotsUpgradeHarness();
  const preview = await h.run({ apply: false });
  assert.equal(preview.result, 'preview');
  assert.equal(preview.previousContainerId, h.current.Id);
  assert.equal(preview.targetRuntimeProfile, slotsPin.runtimeProfile);
  assert.notEqual(preview.previousCommandSha256, preview.targetCommandSha256);
  assert.deepEqual(h.calls, []);
  h.current.Config.Cmd = [...h.current.Config.Cmd, '--metrics'];
  await assert.rejects(h.run({ apply: false }), /runtime_attestation_refused/u);
  assert.deepEqual(h.calls, []);
});

test('same-model slots upgrade records capability after smoke and retains its original receipt', async () => {
  const h = slotsUpgradeHarness();
  const before = structuredClone(h.receipt);
  assert.equal((await h.run()).result, 'upgraded');
  assert.deepEqual(h.transition.previousReceipt, before);
  assert.equal(h.receipt.modelSha256, before.modelSha256);
  assert.notEqual(h.receipt.containerId, before.containerId);
  assert.equal(h.receipt.runtimeProfile, slotsPin.runtimeProfile);
  assert.equal(h.receipt.commandSha256, commercialLlmCommandSha256(slotsPin));
  assert.deepEqual(h.calls, [
    'prepare',
    'journal_prepared',
    'stop_old',
    'remove_old',
    'create_target',
    'journal_started',
    'smoke_target',
    'receipt',
    'journal_complete',
  ]);
  const calls = [...h.calls];
  assert.equal((await h.run()).result, 'already_upgraded');
  assert.deepEqual(h.calls, calls);
});

for (const boundary of [
  'prepare',
  'prepared',
  'stop',
  'remove',
  'create',
  'started',
  'ready',
  'smoke',
  'receipt',
  'complete',
]) {
  test(`slots upgrade resumes interruption after ${boundary} without repeating container replacement`, async () => {
    const h = slotsUpgradeHarness(boundary);
    await assert.rejects(h.run(), /interrupted_/u);
    if (['prepare', 'prepared'].includes(boundary)) assert.equal(h.current.State.Running, true);
    if (['ready', 'smoke'].includes(boundary)) assert.equal(h.receipt.runtimeProfile, undefined);
    await h.run();
    assert.equal(h.transition.phase, 'complete');
    assert.equal(h.current.Id, h.receipt.containerId);
    assert.equal(h.calls.filter((value) => value === 'remove_old').length, 1);
    assert.equal(h.calls.filter((value) => value === 'create_target').length, 1);
  });
}

test('slots upgrade refuses source, receipt, profile and captured-generation drift before mutation', async () => {
  for (const mutate of [
    (h) => {
      h.receipt.containerId = 'e'.repeat(64);
    },
    (h) => {
      h.receipt.commandSha256 = commercialLlmCommandSha256(slotsPin);
    },
    (h) => {
      h.current.HostConfig.PortBindings = { '8080/tcp': [] };
    },
    (h) => {
      h.current.Config.Cmd = commercialLlmCommand(slotsPin);
    },
    (h) => {
      h.io.prepare = () => {
        h.current.Id = 'e'.repeat(64);
      };
    },
  ]) {
    const h = slotsUpgradeHarness();
    mutate(h);
    await assert.rejects(h.run());
    assert.equal(h.calls.includes('stop_old'), false);
    assert.equal(h.calls.includes('create_target'), false);
  }
  for (const mutate of [
    (h) => {
      h.current.Id = 'c'.repeat(64);
    },
    (h) => {
      h.current.Config.Cmd = commercialLlmCommand(pin);
    },
    (h) => {
      h.transition.targetCommandSha256 = commercialLlmCommandSha256(pin);
    },
    (h) => {
      h.transition.previousReceipt.containerId = 'c'.repeat(64);
    },
    (h) => {
      h.transition.sourceSha = 'e'.repeat(40);
    },
    (h) => {
      h.transition.kind = 'gemma4-to-qwen35-9b-v1';
    },
  ]) {
    const h = slotsUpgradeHarness('smoke');
    await assert.rejects(h.run(), /interrupted_smoke/u);
    const calls = [...h.calls];
    mutate(h);
    await assert.rejects(h.run());
    assert.deepEqual(h.calls, calls);
  }
});

test('slots upgrade preserves a completed predecessor journal and refuses an unsettled predecessor', async () => {
  const prior = replacementHarness();
  await prior.run();
  const predecessor = { ...prior.transition, targetContainerId: 'a'.repeat(64) };
  const before = JSON.stringify(predecessor);
  const h = slotsUpgradeHarness();
  h.previousTransition = predecessor;
  await h.run();
  assert.equal(JSON.stringify(predecessor), before);
  assert.notEqual(h.transition.kind, predecessor.kind);
  for (const previousTransition of [
    { ...predecessor, phase: 'started' },
    { ...predecessor, targetContainerId: 'c'.repeat(64) },
  ]) {
    const failed = slotsUpgradeHarness();
    failed.previousTransition = previousTransition;
    await assert.rejects(failed.run(), /predecessor_transition_unsettled/u);
    assert.deepEqual(failed.calls, []);
  }
});

test('a completed slots transition cannot adopt a foreign target receipt or a replacement generation', async () => {
  for (const mutate of [
    (h) => {
      h.receipt.sourceSha = 'e'.repeat(40);
    },
    (h) => {
      h.receipt.commandSha256 = commercialLlmCommandSha256(pin);
    },
    (h) => {
      h.current.Id = 'c'.repeat(64);
    },
    (h) => {
      h.receipt.state = 'stopped';
      h.current.State.Running = false;
    },
  ]) {
    const h = slotsUpgradeHarness();
    await h.run();
    const calls = [...h.calls];
    mutate(h);
    await assert.rejects(h.run());
    assert.deepEqual(h.calls, calls);
  }
});

test('embedded template and application model provenance cannot silently drift', () => {
  for (const props of [{}, { chat_template: 'different' }, { chat_template: null }])
    assert.throws(() => assertCommercialLlmTemplate(props), /template_identity_refused/u);
  const protocol = readFileSync(
    resolve(root, 'apps/api/src/moderation/commercial/commercial-llm.protocol.ts'),
    'utf8',
  );
  for (const value of [pin.alias, pin.modelSha256, pin.templateSha256])
    assert.ok(protocol.includes(value));
  assert.equal(service.command.includes('--chat-template-file'), false);
  assert.equal(service.command.includes('--jinja'), true);
  assert.equal(service.volumes.length, 1);
});

function recoveryIo({
  profile = pin,
  running = true,
  failSmoke = false,
  failArtifacts = false,
  replaceAfterArtifacts = false,
} = {}) {
  const state = container(profile);
  state.State.Running = running;
  state.State.Health.Status = running ? 'healthy' : 'unhealthy';
  const calls = [];
  const receipts = [];
  const io = {
    inspect: () => {
      calls.push('inspect');
      return structuredClone(state);
    },
    verifyArtifacts: async () => {
      calls.push('verify_all_artifacts');
      if (failArtifacts) throw new Error('checksum failed');
      if (replaceAfterArtifacts) state.Id = 'b'.repeat(64);
    },
    capacity: () => {
      calls.push('capacity');
    },
    start: (id) => {
      assert.equal(id, 'a'.repeat(64));
      calls.push('start_captured_id');
      state.State.Running = true;
    },
    stop: (id) => {
      assert.equal(id, 'a'.repeat(64));
      calls.push('stop_captured_id');
      state.State.Running = false;
    },
    waitReady: (id) => {
      assert.equal(id, 'a'.repeat(64));
      calls.push('ready_captured_id');
      state.State.Health.Status = 'healthy';
    },
    smoke: (id) => {
      assert.equal(id, 'a'.repeat(64));
      calls.push('smoke_captured_id');
      if (failSmoke) throw new Error('smoke failed');
      return structuredClone(state);
    },
    record: (receipt) => {
      calls.push('record_success');
      receipts.push(receipt);
    },
    emit: (stage) => {
      calls.push(`emit_${stage}`);
    },
  };
  return { io, calls, receipts, state };
}

test('interrupted unrecorded install succeeds only after exact artifacts, readiness and smoke', async () => {
  const observed = recoveryIo({ running: false });
  const result = await reconcileCommercialLlmGeneration({
    operation: 'install',
    sourceSha: 'e'.repeat(40),
    receipt: undefined,
    io: observed.io,
  });
  assert.equal(result.result, 'recovered_unrecorded_generation');
  assert.equal(observed.receipts.length, 1);
  assert.equal(observed.receipts[0].sourceSha, 'e'.repeat(40));
  assertCommercialLlmReceipt(observed.receipts[0]);
  const order = [
    'verify_all_artifacts',
    'capacity',
    'start_captured_id',
    'ready_captured_id',
    'smoke_captured_id',
    'record_success',
  ];
  assert.deepEqual(
    observed.calls.filter((call) => order.includes(call)),
    order,
  );
});

test('ordinary recovery and stop preserve both pinned configurations without upgrading an existing generation', async () => {
  for (const profile of [pin, slotsPin]) {
    const observed = recoveryIo({ profile, running: false });
    const receipt = { ...recoveryReceipt(profile), state: 'stopped' };
    await reconcileCommercialLlmGeneration({
      operation: 'install',
      sourceSha: 'e'.repeat(40),
      receipt,
      io: observed.io,
    });
    assert.equal(observed.receipts[0].containerId, receipt.containerId);
    assert.equal(observed.receipts[0].sourceSha, receipt.sourceSha);
    assert.equal(commercialLlmReceiptProfile(observed.receipts[0]), profile);
    assert.deepEqual(observed.state.Config.Cmd, commercialLlmCommand(profile));
    await reconcileCommercialLlmGeneration({
      operation: 'stop',
      sourceSha: 'e'.repeat(40),
      receipt: observed.receipts[0],
      io: observed.io,
    });
    assert.equal(observed.receipts[1].state, 'stopped');
    assert.equal(commercialLlmReceiptProfile(observed.receipts[1]), profile);
  }
  const unrecorded = recoveryIo({ profile: slotsPin });
  await reconcileCommercialLlmGeneration({
    operation: 'install',
    sourceSha: 'e'.repeat(40),
    io: unrecorded.io,
  });
  assert.equal(unrecorded.receipts[0].runtimeProfile, slotsPin.runtimeProfile);
  assert.equal(unrecorded.receipts[0].commandSha256, commercialLlmCommandSha256(slotsPin));
});

test('ordinary management refuses a historical receipt paired with a slots container before stopping it', async () => {
  const observed = recoveryIo({ profile: slotsPin });
  await assert.rejects(
    reconcileCommercialLlmGeneration({
      operation: 'stop',
      sourceSha: 'e'.repeat(40),
      receipt: recoveryReceipt(),
      io: observed.io,
    }),
    /runtime_attestation_refused/u,
  );
  assert.deepEqual(observed.calls, ['inspect']);
});

test('failed recovery smoke leaves success absent and permits stopping that exact unrecorded generation', async () => {
  const observed = recoveryIo({ failSmoke: true });
  await assert.rejects(
    reconcileCommercialLlmGeneration({
      operation: 'install',
      sourceSha: 'e'.repeat(40),
      receipt: undefined,
      io: observed.io,
    }),
    /smoke failed/u,
  );
  assert.equal(observed.receipts.length, 0);
  const result = await reconcileCommercialLlmGeneration({
    operation: 'stop',
    sourceSha: 'e'.repeat(40),
    receipt: undefined,
    io: observed.io,
  });
  assert.equal(result.result, 'unrecorded_generation_stopped');
  assert.equal(result.successReceiptWritten, false);
  assert.equal(observed.state.State.Running, false);
  assert.equal(observed.receipts.length, 0);
  assert.ok(observed.calls.includes('stop_captured_id'));
});

test('recovery refuses malformed, foreign or mismatched existing receipts before changing the generation', async () => {
  for (const receipt of [
    {},
    { ...recoveryReceipt(), imageRef: 'foreign' },
    { ...recoveryReceipt(), containerId: 'b'.repeat(64) },
  ]) {
    const observed = recoveryIo();
    await assert.rejects(
      reconcileCommercialLlmGeneration({
        operation: 'install',
        sourceSha: 'e'.repeat(40),
        receipt,
        io: observed.io,
      }),
      /receipt/u,
    );
    assert.equal(observed.receipts.length, 0);
    assert.equal(
      observed.calls.some((call) => call.startsWith('start_') || call.startsWith('stop_')),
      false,
    );
    assert.equal(observed.calls.includes('verify_all_artifacts'), false);
  }
});

test('recovery refuses artifact uncertainty and any generation replacement before start or stop', async () => {
  for (const operation of ['install', 'stop']) {
    for (const options of [{ failArtifacts: true }, { replaceAfterArtifacts: true }]) {
      const observed = recoveryIo({ running: false, ...options });
      await assert.rejects(
        reconcileCommercialLlmGeneration({
          operation,
          sourceSha: 'e'.repeat(40),
          receipt: undefined,
          io: observed.io,
        }),
        /checksum|generation_changed/u,
      );
      assert.equal(observed.receipts.length, 0);
      assert.equal(
        observed.calls.some((call) => call.startsWith('start_') || call.startsWith('stop_')),
        false,
      );
    }
  }
});

test('unrecorded recovery cannot adopt a relaxed runtime even with a matching image', async () => {
  const observed = recoveryIo();
  observed.state.HostConfig.ReadonlyRootfs = false;
  await assert.rejects(
    reconcileCommercialLlmGeneration({
      operation: 'stop',
      sourceSha: 'e'.repeat(40),
      receipt: undefined,
      io: observed.io,
    }),
    /attestation_refused/u,
  );
  assert.equal(observed.calls.includes('verify_all_artifacts'), false);
  assert.equal(observed.calls.includes('stop_captured_id'), false);
});

test('recorded stopped generation restarts its captured ID and preserves original verified provenance', async () => {
  const observed = recoveryIo({ running: false });
  const receipt = { ...recoveryReceipt(), state: 'stopped' };
  await reconcileCommercialLlmGeneration({
    operation: 'install',
    sourceSha: 'e'.repeat(40),
    receipt,
    io: observed.io,
  });
  assert.equal(observed.receipts.length, 1);
  assert.equal(observed.receipts[0].sourceSha, receipt.sourceSha);
  assert.equal(observed.receipts[0].installedAt, receipt.installedAt);
  assert.equal(observed.receipts[0].state, 'installed');
  assert.ok(observed.calls.indexOf('record_success') > observed.calls.indexOf('smoke_captured_id'));
});

test('same-generation proof is retained through readiness, smoke and stopped readback', async () => {
  const replaced = recoveryIo({ running: false });
  const originalReady = replaced.io.waitReady;
  replaced.io.waitReady = (id) => {
    originalReady(id);
    replaced.state.Id = 'b'.repeat(64);
  };
  await assert.rejects(
    reconcileCommercialLlmGeneration({
      operation: 'install',
      sourceSha: 'e'.repeat(40),
      io: replaced.io,
    }),
    /generation_changed/u,
  );
  assert.equal(replaced.receipts.length, 0);

  const notStopped = recoveryIo();
  notStopped.io.stop = () => {};
  await assert.rejects(
    reconcileCommercialLlmGeneration({
      operation: 'stop',
      sourceSha: 'e'.repeat(40),
      io: notStopped.io,
    }),
    /stop_readback_refused/u,
  );
  assert.equal(notStopped.receipts.length, 0);
});

test('client smoke identity matches the actual API protocol after a model transition', async () => {
  const source = stripTypeScriptTypes(
    readFileSync(
      resolve(root, 'apps/api/src/moderation/commercial/commercial-llm.protocol.ts'),
      'utf8',
    ),
  );
  const protocol = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  );
  assert.equal(pin.alias, protocol.COMMERCIAL_LLM_MODEL_ALIAS);
  assert.equal(pin.modelSha256, protocol.COMMERCIAL_LLM_MODEL_SHA256);
  assert.equal(pin.templateSha256, protocol.COMMERCIAL_LLM_CHAT_TEMPLATE_SHA256);
  assert.equal(pin.smokePromptSha256, protocol.COMMERCIAL_LLM_PROMPT_SHA256);
  assert.notEqual(pin.smokePromptSha256, legacyPin.smokePromptSha256);
  const response = {
    ok: true,
    casesPassed: 2,
    casesTotal: 2,
    modelSha256: protocol.COMMERCIAL_LLM_MODEL_SHA256,
    promptSha256: protocol.COMMERCIAL_LLM_PROMPT_SHA256,
    cases: [
      { name: 'commercial-service', classification: 'COMMERCIAL', durationMs: 1000 },
      { name: 'personal-used-item', classification: 'NOT_COMMERCIAL', durationMs: 1000 },
    ],
  };
  assert.deepEqual(validateCommercialLlmClientSmokeResponse(response), response);
  assert.throws(
    () =>
      validateCommercialLlmClientSmokeResponse({
        ...response,
        promptSha256: legacyPin.smokePromptSha256,
      }),
    /commercial_llm_client_smoke_refused/u,
  );
});

test('production-prompt smoke forwards only exact synthetic case results and bounded latency', () => {
  const valid = {
    ok: true,
    casesPassed: 2,
    casesTotal: 2,
    modelSha256: pin.modelSha256,
    promptSha256: pin.smokePromptSha256,
    cases: [
      {
        name: 'commercial-service',
        classification: 'COMMERCIAL',
        durationMs: 0,
      },
      {
        name: 'personal-used-item',
        classification: 'NOT_COMMERCIAL',
        durationMs: 60000,
      },
    ],
  };
  const accepted = validateCommercialLlmClientSmokeResponse(valid);
  assert.deepEqual(accepted, valid);
  assert.notEqual(accepted, valid);
  assert.notEqual(accepted.cases, valid.cases);
  assert.notEqual(accepted.cases[0], valid.cases[0]);
  for (const invalid of [
    null,
    [],
    { ...valid, ok: false },
    { ...valid, casesPassed: 1 },
    { ...valid, casesTotal: 3 },
    { ...valid, modelSha256: '0'.repeat(64) },
    { ...valid, promptSha256: '0'.repeat(64) },
    { ...valid, extra: 'unallowlisted output' },
    { ...valid, cases: [] },
    { ...valid, cases: [...valid.cases].reverse() },
    { ...valid, cases: [valid.cases[0], valid.cases[0]] },
    ...['COMMERCIAL', 'UNSURE', null].map((classification) => ({
      ...valid,
      cases: [valid.cases[0], { ...valid.cases[1], classification }],
    })),
    ...[-1, 60001, NaN, Infinity, -Infinity, '2000', undefined].map((durationMs) => ({
      ...valid,
      cases: [{ ...valid.cases[0], durationMs }, valid.cases[1]],
    })),
    {
      ...valid,
      cases: [{ ...valid.cases[0], text: 'must not be forwarded' }, valid.cases[1]],
    },
    { ...valid, cases: [null, valid.cases[1]] },
  ]) {
    assert.throws(
      () => validateCommercialLlmClientSmokeResponse(invalid),
      /commercial_llm_client_smoke_refused/u,
    );
  }
});

test('client smoke preserves bounded structured admission refusal without forwarding private errors', () => {
  const diagnostic = {
    schemaVersion: 1,
    ok: false,
    stage: 'admission',
    code: 'ADMISSION_BLOCKED',
    admission: {
      observedAt: '2026-11-01T10:13:28.248Z',
      leaseState: 'HELD_PERSISTENT',
      cooldownState: 'MISSING',
    },
  };
  assert.deepEqual(validateCommercialLlmClientSmokeFailure(diagnostic), diagnostic);
  for (const buffer of ['stdout', 'stderr']) {
    assert.throws(
      () =>
        executeCommercialLlmClientSmoke((file, args, options) => {
          assert.equal(file, 'docker');
          assert.equal(
            args.at(-1),
            'apps/api/dist/apps/api/src/scripts/commercial-llm-shadow-smoke.js',
          );
          assert.equal(options.timeout, 140000);
          assert.equal(options.maxBuffer, 16384);
          throw Object.assign(new Error('redis://secret arbitrary source'), {
            status: 1,
            stdout: 'private model output',
            stderr: 'private connection exception',
            [buffer]: Buffer.from(JSON.stringify(diagnostic)),
          });
        }),
      (error) => {
        assert.equal(
          error.message,
          'commercial_llm_client_smoke_failed:admission:ADMISSION_BLOCKED',
        );
        assert.deepEqual(error.diagnostic, diagnostic);
        assert.equal(JSON.stringify(error).includes('secret'), false);
        return true;
      },
    );
  }
  for (const invalid of [
    { ...diagnostic, token: 'private' },
    { ...diagnostic, code: '__proto__' },
    { ...diagnostic, code: {} },
    { ...diagnostic, stage: 'process' },
    { ...diagnostic, admission: { ...diagnostic.admission, token: 'private' } },
    { ...diagnostic, admission: { ...diagnostic.admission, leaseState: 'private-token' } },
    { ...diagnostic, admission: { ...diagnostic.admission, observedAt: 'invalid' } },
    { ...diagnostic, admission: undefined },
  ])
    assert.throws(() => validateCommercialLlmClientSmokeFailure(invalid));
});

test('client smoke fails closed on legacy unstructured errors, timeout, overflow and invalid success', () => {
  const safe = (operation, code) =>
    assert.throws(operation, (error) => {
      assert.deepEqual(error.diagnostic, { schemaVersion: 1, ok: false, stage: 'process', code });
      assert.equal(error.message.includes('private'), false);
      return true;
    });
  for (const [errorCode, code] of [
    [undefined, 'PROCESS_FAILED'],
    ['ETIMEDOUT', 'PROCESS_TIMEOUT'],
    ['ENOBUFS', 'PROCESS_FAILED'],
  ])
    safe(
      () =>
        executeCommercialLlmClientSmoke(() => {
          throw Object.assign(new Error('private source'), {
            code: errorCode,
            stdout: 'private prompt',
            stderr: 'private token',
          });
        }),
      code,
    );
  safe(() => executeCommercialLlmClientSmoke(() => 'private output'), 'INVALID_OUTPUT');
  safe(() => executeCommercialLlmClientSmoke(() => 'x'.repeat(16385)), 'INVALID_OUTPUT');
  safe(
    () =>
      executeCommercialLlmClientSmoke(() => {
        throw Object.assign(new Error('private error'), {
          stdout: 'x'.repeat(16385),
          stderr: 'private error',
        });
      }),
    'PROCESS_FAILED',
  );
  for (const [code, stage] of Object.entries({
    REDIS_UNAVAILABLE: 'redis',
    MODEL_TIMEOUT: 'classification',
    MODEL_INVALID_RESPONSE: 'classification',
    UNEXPECTED_CLASSIFICATION: 'classification',
    LEASE_LOST: 'ownership',
    LEASE_RELEASE_UNAVAILABLE: 'ownership',
  }))
    assert.deepEqual(
      validateCommercialLlmClientSmokeFailure({
        schemaVersion: 1,
        ok: false,
        stage,
        code,
      }),
      { schemaVersion: 1, ok: false, stage, code },
    );
});

test('client smoke execution keeps the existing successful result shape', () => {
  const success = {
    ok: true,
    casesPassed: 2,
    casesTotal: 2,
    modelSha256: pin.modelSha256,
    promptSha256: pin.smokePromptSha256,
    cases: [
      { name: 'commercial-service', classification: 'COMMERCIAL', durationMs: 10 },
      { name: 'personal-used-item', classification: 'NOT_COMMERCIAL', durationMs: 20 },
    ],
  };
  assert.deepEqual(
    executeCommercialLlmClientSmoke(() => JSON.stringify(success)),
    success,
  );
});
