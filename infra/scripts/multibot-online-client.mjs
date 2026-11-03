import { execFile, spawn } from 'node:child_process';
import { validateMultibotComposeArgs } from './multibot-prepare-capacity.mjs';
import { requireOutcomeCohortTarget } from '../../scripts/agent/outcome-cohort-online-targets.mjs';
import { verifyRoutingIndexDatabaseUrl } from '../../scripts/agent/routing-index-online-target.mjs';

const shaPattern = /^[a-f0-9]{40}$/u;
const imageIdPattern = /^sha256:[a-f0-9]{64}$/u;
const idPattern = /^[a-f0-9]{64}$/u;
const tagPattern =
  /^maxim-online-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const fail = (code) => {
  throw new Error(`MULTIBOT_PREPARE_CLIENT_${code}`);
};

function runClientCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024,
        killSignal: 'SIGKILL',
        ...options,
      },
      (error, stdout) => (error ? reject(error) : resolve({ stdout })),
    );
    child.stdin.on('error', () => {});
    child.stdin.end();
  });
}

export function verifyMultibotOnlineDatabaseUrl(value, project) {
  let address;
  try {
    address = new URL(value);
  } catch {
    fail('DATABASE_SCOPE_INVALID');
  }
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    /[\0\r\n]/u.test(value) ||
    !['postgresql:', 'postgres:'].includes(address.protocol) ||
    address.hash ||
    !['postgres', `${project}-postgres-1`].includes(address.hostname) ||
    !['', '5432'].includes(address.port) ||
    address.username !== 'maxim' ||
    address.pathname !== '/maxim' ||
    !address.password ||
    address.searchParams.getAll('schema').length > 1 ||
    (address.searchParams.has('schema') && address.searchParams.get('schema') !== 'public') ||
    address.searchParams.has('host') ||
    address.searchParams.has('application_name') ||
    address.searchParams
      .getAll('options')
      .some((option) => /application_name|search_path/iu.test(option))
  )
    fail('DATABASE_SCOPE_INVALID');
  return value;
}

// FLAG: Read effective Compose configuration only in private memory. Its environment
// can contain bot secrets, so never log it or inherit a service's env/volumes into clients.
export function verifyMultibotOnlineClientConfiguration(config, composeArgs, expectedSha) {
  validateMultibotComposeArgs(composeArgs);
  if (!shaPattern.test(expectedSha ?? '')) fail('SOURCE_SHA_INVALID');
  const projectOption = composeArgs.findIndex((value) => ['-p', '--project-name'].includes(value));
  const project = projectOption >= 0 ? composeArgs[projectOption + 1] : config?.name;
  const service = config?.services?.['api-ingress'];
  const network = config?.networks?.default;
  if (
    typeof project !== 'string' ||
    !/^[a-z0-9][a-z0-9_-]*$/u.test(project) ||
    config?.name !== project ||
    !service ||
    service.image !== `maxim-api:${expectedSha}` ||
    !network ||
    network.external === true ||
    network.name !== `${project}_default` ||
    (network.driver !== undefined && network.driver !== 'bridge') ||
    (service.networks !== undefined &&
      (!service.networks ||
        Array.isArray(service.networks) ||
        Object.keys(service.networks).join(',') !== 'default'))
  )
    fail('CONFIGURATION_INVALID');
  return {
    project,
    networkName: network.name,
    imageRef: service.image,
    databaseUrl: verifyMultibotOnlineDatabaseUrl(service.environment?.DATABASE_URL, project),
  };
}

export function verifyMultibotOnlineClientImage(image, expectedSha) {
  if (
    !imageIdPattern.test(image?.Id ?? '') ||
    image.Config?.User !== 'node' ||
    image.Config.Labels?.['com.maxim.release-protected'] !== 'true' ||
    image.Config.Labels?.['org.opencontainers.image.revision'] !== expectedSha
  )
    fail('IMAGE_INVALID');
  return image.Id;
}

export function verifyMultibotOnlineClientNetwork(network, configuration) {
  if (
    !idPattern.test(network?.Id ?? '') ||
    network.Name !== configuration.networkName ||
    network.Driver !== 'bridge' ||
    network.Scope !== 'local' ||
    network.Labels?.['com.docker.compose.project'] !== configuration.project ||
    network.Labels?.['com.docker.compose.network'] !== 'default'
  )
    fail('NETWORK_INVALID');
  return network.Id;
}

export function multibotOnlineClientCreateArgs(applicationName, identity) {
  if (!tagPattern.test(applicationName)) fail('IDENTITY_INVALID');
  if (
    !imageIdPattern.test(identity?.imageId ?? '') ||
    !idPattern.test(identity?.networkId ?? '') ||
    typeof identity.networkName !== 'string' ||
    !/^[a-z0-9][a-z0-9_-]*_default$/u.test(identity.networkName)
  )
    fail('IDENTITY_INVALID');
  return [
    'create',
    '--rm',
    '--pull',
    'never',
    '--name',
    applicationName,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '64',
    '--memory',
    '512m',
    '--cpus',
    '0.5',
    '--user',
    '1000:1000',
    '--network',
    identity.networkId,
    '--workdir',
    '/app',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    '--tmpfs',
    '/app/apps/api/.migration-prepare:rw,noexec,nosuid,uid=1000,gid=1000,mode=0700,size=256m',
    '-e',
    'DATABASE_URL',
    '-e',
    'NODE_ENV=production',
    '-e',
    `MAXIM_MULTIBOT_PREPARE_APPLICATION_NAME=${applicationName}`,
    '--entrypoint',
    'node',
    identity.imageId,
    'scripts/agent/multibot-online-prepare.mjs',
  ];
}

// FLAG: Await create before issuing start. A create timeout cannot cause SQL later:
// the object has never received a start request. The supervisor owns exact removal
// and reports uncertain preparation cleanup instead of treating name absence as proof.
export async function createMultibotOnlineClientLauncher(composeArgs, options = {}) {
  return createOnlineClientLauncher(composeArgs, options, multibotOnlineClientCreateArgs);
}

export function outcomeCohortOnlineClientCreateArgs(applicationName, identity, selector) {
  requireOutcomeCohortTarget(selector);
  const args = multibotOnlineClientCreateArgs(applicationName, identity);
  return [...args.slice(0, -1), 'scripts/agent/outcome-cohort-online-prepare.mjs', selector];
}

export async function createOutcomeCohortOnlineClientLauncher(composeArgs, selector, options = {}) {
  requireOutcomeCohortTarget(selector);
  return createOnlineClientLauncher(composeArgs, options, (applicationName, identity) =>
    outcomeCohortOnlineClientCreateArgs(applicationName, identity, selector),
  );
}

export function routingIndexOnlineClientCreateArgs(applicationName, identity) {
  const args = multibotOnlineClientCreateArgs(applicationName, identity);
  return [...args.slice(0, -1), 'scripts/agent/routing-index-online-prepare.mjs'];
}

export async function createRoutingIndexOnlineClientLauncher(composeArgs, selector, options = {}) {
  if (selector !== 'routing') fail('TARGET_INVALID');
  return createOnlineClientLauncher(
    composeArgs,
    options,
    routingIndexOnlineClientCreateArgs,
    verifyRoutingIndexDatabaseUrl,
  );
}

async function createOnlineClientLauncher(
  composeArgs,
  { run = runClientCommand, env = process.env, start = spawn },
  createArgs,
  validateDatabase = () => {},
) {
  validateMultibotComposeArgs(composeArgs);
  const read = async (args, options) => {
    try {
      const result = await run('docker', args, options);
      if (typeof result?.stdout !== 'string') fail('COMMAND_FAILED');
      return result.stdout.trim();
    } catch {
      fail('COMMAND_FAILED');
    }
  };
  const json = async (args) => {
    try {
      return JSON.parse(await read(args));
    } catch {
      fail('METADATA_INVALID');
    }
  };
  const config = verifyMultibotOnlineClientConfiguration(
    await json(['compose', ...composeArgs, 'config', '--format', 'json']),
    composeArgs,
    env.MAXIM_EXPECTED_DEPLOY_SHA,
  );
  validateDatabase(config.databaseUrl);
  const images = await json(['image', 'inspect', config.imageRef]);
  const networks = await json(['network', 'inspect', config.networkName]);
  if (
    !Array.isArray(images) ||
    images.length !== 1 ||
    !Array.isArray(networks) ||
    networks.length !== 1
  )
    fail('METADATA_INVALID');
  const imageId = verifyMultibotOnlineClientImage(images[0], env.MAXIM_EXPECTED_DEPLOY_SHA);
  const networkId = verifyMultibotOnlineClientNetwork(networks[0], config);
  let preparedName;
  let preparationAttempted = false;
  let started = false;
  return {
    identity: Object.freeze({ sourceSha: env.MAXIM_EXPECTED_DEPLOY_SHA, imageId, networkId }),
    prepare: async (applicationName) => {
      if (preparationAttempted || started) fail('ALREADY_PREPARED');
      preparationAttempted = true;
      const freshNetworks = await json(['network', 'inspect', config.networkName]);
      if (
        !Array.isArray(freshNetworks) ||
        freshNetworks.length !== 1 ||
        verifyMultibotOnlineClientNetwork(freshNetworks[0], config) !== networkId
      )
        fail('NETWORK_CHANGED');
      const args = createArgs(applicationName, {
        imageId,
        networkId,
        networkName: config.networkName,
      });
      const created = await read(args, { env: { ...env, DATABASE_URL: config.databaseUrl } });
      if (!idPattern.test(created)) fail('CREATE_UNCONFIRMED');
      preparedName = applicationName;
    },
    start: (applicationName) => {
      if (applicationName !== preparedName || started) fail('START_WITHOUT_PREPARATION');
      started = true;
      return start('docker', ['start', '--attach', applicationName], { stdio: 'inherit' });
    },
  };
}
