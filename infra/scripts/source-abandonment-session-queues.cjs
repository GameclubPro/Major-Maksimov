'use strict';

const { createHash } = require('node:crypto');
const {
  controlWebhookQueues,
  createRedisOwnershipStore,
  WEBHOOK_QUEUE_NAMES,
  WEBHOOK_ROLLOUT_OWNER_KEY,
} = require('./webhook-queue-rollout-control.cjs');

const CONNECTION_OPTIONS = Object.freeze({
  lazyConnect: true,
  commandTimeout: 1000,
  connectTimeout: 1000,
  maxRetriesPerRequest: 0,
  retryStrategy: null,
  reconnectOnError: null,
  autoResendUnfulfilledCommands: false,
  enableOfflineQueue: false,
});
const QUEUE_LIMITS = Object.freeze({
  queueCount: 54,
  legacyQueueCount: 53,
  operationMs: 1500,
  drainMs: 60000,
  restoreMs: 30000,
  pollMs: 1000,
  outputBytes: 16384,
});
const noncePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const namePattern =
  /^maxim-source-session:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const hashPattern = /^[0-9a-f]{64}$/u;
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const requireFact = (condition, code) => {
  if (!condition) throw new Error(code);
};
const ownerToken = (nonce) => {
  requireFact(
    typeof nonce === 'string' && noncePattern.test(nonce),
    'session_queue_nonce_unproved',
  );
  return `rollout:${createHash('sha256').update(nonce).digest('hex')}`;
};
// FLAG: Retained baselines keep their exact names, count and pause states. Only
// the reviewed command-queue addition distinguishes the current and legacy shapes.
function isSupportedSourceAbandonmentQueueInventory(queueNames) {
  return (
    Array.isArray(queueNames) &&
    ((queueNames.length === QUEUE_LIMITS.queueCount &&
      queueNames.includes('admin-manual-commands')) ||
      (queueNames.length === QUEUE_LIMITS.legacyQueueCount &&
        !queueNames.includes('admin-manual-commands'))) &&
    new Set(queueNames).size === queueNames.length &&
    Array.from(queueNames).every(
      (name) => typeof name === 'string' && /^[a-z0-9][a-z0-9:_-]{0,127}$/u.test(name),
    )
  );
}
function registry(queueNames) {
  requireFact(
    isSupportedSourceAbandonmentQueueInventory(queueNames) &&
      queueNames.every(
        (name) => typeof name === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/u.test(name),
      ) &&
      WEBHOOK_QUEUE_NAMES.length === 24 &&
      WEBHOOK_QUEUE_NAMES.every((name) => queueNames.includes(name)),
    'session_queue_registry_unproved',
  );
  return Object.freeze([...queueNames]);
}
function exactIdentity(value, connectionName) {
  requireFact(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(',') === 'clientId,connectionName' &&
      Number.isSafeInteger(value.clientId) &&
      value.clientId > 0 &&
      namePattern.test(value.connectionName ?? '') &&
      value.connectionName === connectionName,
    'session_queue_connection_identity_unproved',
  );
  return { clientId: value.clientId, connectionName: value.connectionName };
}
function buildQueueReadScripts(queueNames) {
  const names = registry(queueNames);
  const queues = `-- maxim-source-session-queue-state-v1
local names={${names.map((name) => `'${name}'`).join(',')}} local rows={}
for _,name in ipairs(names) do
 local prefix='bull:'..name..':' local meta=prefix..'meta' local active=prefix..'active'
 local mk=redis.call('TYPE',meta).ok local ak=redis.call('TYPE',active).ok
 if (mk~='none' and mk~='hash') or (ak~='none' and ak~='list') then return {0} end
 local paused=0
 if mk=='hash' then
  if redis.call('HSTRLEN',meta,'paused')>1 then return {0} end
  local raw=redis.call('HGET',meta,'paused')
  if raw=='1' then paused=1 elseif raw~=false then return {0} end
 end
 table.insert(rows,{name,ak=='none' and 0 or redis.call('LLEN',active),paused})
end return {1,rows}`;
  const fence = queues.replace(
    'return {1,rows}',
    `local webhook={${WEBHOOK_QUEUE_NAMES.map((name) => `['${name}']=true`).join(',')}}
local paused=0 local active=0
for _,row in ipairs(rows) do if webhook[row[1]] then paused=paused+row[3] active=active+row[2] end end
local key='${WEBHOOK_ROLLOUT_OWNER_KEY}' local kind=redis.call('TYPE',key).ok
if kind~='none' and kind~='string' then return {0} end
if kind=='string' and redis.call('STRLEN',key)>72 then return {0} end
local owner=kind=='string' and redis.call('GET',key) or false
return {1,24,paused,active,owner and 1 or 0,owner==ARGV[1] and 1 or 0}`,
  );
  return Object.freeze({ queues, fence });
}
const OWNER_READ_SCRIPT = `local kind=redis.call('TYPE',KEYS[1]).ok
if kind=='none' then return {1,false} end
if kind~='string' or redis.call('STRLEN',KEYS[1])>72 then return {0} end
return {1,redis.call('GET',KEYS[1])}`;

// FLAG: All queue operations, including the existing stock 24-queue owner
// protocol, share one established connection and one FIFO. Uncertain replies
// poison that connection; no reconnect, automatic resend or queued resume follows.
function createQueueClient(redis, Queue, { queueNames } = {}) {
  const names = registry(queueNames),
    scripts = buildQueueReadScripts(names);
  const auxiliary = names.filter((name) => !WEBHOOK_QUEUE_NAMES.includes(name));
  const options = redis?.options;
  requireFact(
    redis?.status === 'ready' &&
      options?.maxRetriesPerRequest === 0 &&
      options.retryStrategy === null &&
      options.reconnectOnError === null &&
      options.autoResendUnfulfilledCommands === false &&
      options.enableOfflineQueue === false &&
      Number.isSafeInteger(options.commandTimeout) &&
      options.commandTimeout > 0 &&
      options.commandTimeout <= 1000 &&
      Number.isSafeInteger(options.connectTimeout) &&
      options.connectTimeout > 0 &&
      options.connectTimeout <= 1000 &&
      namePattern.test(options.connectionName ?? ''),
    'session_queue_redis_unbounded',
  );
  let poisoned = false,
    closed = false,
    readyDone = false,
    tail = Promise.resolve();
  const poison = () => {
    poisoned = true;
    redis.disconnect();
  };
  const assertState = () =>
    requireFact(
      !poisoned && !closed && redis.status === 'ready',
      'session_queue_client_unavailable',
    );
  redis.on('close', () => {
    if (!closed) poisoned = true;
  });
  redis.on('end', () => {
    if (!closed) poisoned = true;
  });
  const queues = new Map(
    names.map((name) => [name, new Queue(name, { connection: redis, skipMetasUpdate: true })]),
  );
  for (const queue of queues.values()) queue.on('error', () => {});
  const guarded =
    (fn) =>
    (...args) => {
      assertState();
      return fn(...args);
    };
  async function bounded(work) {
    assertState();
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(work),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            poison();
            reject(new Error('session_queue_operation_unacknowledged'));
          }, QUEUE_LIMITS.operationMs);
        }),
      ]);
    } catch {
      poison();
      throw new Error('session_queue_operation_failed_closed');
    } finally {
      clearTimeout(timer);
    }
  }
  const readiness = bounded(async () => {
    const results = await Promise.allSettled(
      [...queues.values()].map((queue) => queue.waitUntilReady()),
    );
    requireFact(
      results.every((result) => result.status === 'fulfilled'),
      'session_queue_readiness_failed',
    );
    assertState();
    readyDone = true;
  });
  readiness.catch(() => {});
  const run = (work) => {
    const operation = tail.then(async () => {
      await readiness;
      assertState();
      requireFact(readyDone, 'session_queue_readiness_failed');
      return bounded(work);
    });
    tail = operation.catch(() => {});
    return operation;
  };
  const originalStore = createRedisOwnershipStore(redis);
  const ownershipStore = Object.fromEntries(
    Object.entries(originalStore).map(([name, fn]) => [
      name,
      name === 'close' ? async () => {} : guarded(fn),
    ]),
  );
  ownershipStore.getOwner = guarded(async () => {
    const result = await redis.eval_ro(OWNER_READ_SCRIPT, 1, WEBHOOK_ROLLOUT_OWNER_KEY);
    requireFact(
      Array.isArray(result) &&
        result.length === 2 &&
        result[0] === 1 &&
        (result[1] === null ||
          (typeof result[1] === 'string' && /^rollout:[a-f0-9]{64}$/u.test(result[1]))),
      'session_queue_owner_unproved',
    );
    return result[1];
  });
  const stockQueue = (name) => {
    const queue = queues.get(name);
    requireFact(queue && WEBHOOK_QUEUE_NAMES.includes(name), 'session_stock_queue_unproved');
    return Object.fromEntries(
      ['waitUntilReady', 'isPaused', 'getActiveCount', 'pause', 'resume']
        .map((operation) => [operation, guarded(() => queue[operation]())])
        .concat([['close', async () => {}]]),
    );
  };
  const stock = (action, nonce) =>
    run(() =>
      controlWebhookQueues(action, {
        ownerToken: ownerToken(nonce),
        ownershipStore,
        createQueue: stockQueue,
        adoptExistingPause: false,
      }),
    );
  const selected = (name) => {
    requireFact(auxiliary.includes(name), 'session_queue_outside_auxiliary_registry');
    return queues.get(name);
  };
  return Object.freeze({
    ready: () => readiness,
    connectionIdentity: () =>
      run(async () =>
        exactIdentity(
          { clientId: await redis.client('ID'), connectionName: await redis.client('GETNAME') },
          options.connectionName,
        ),
      ),
    readOriginalClientAbsent: (identity) =>
      run(async () => {
        identity = exactIdentity(identity, options.connectionName);
        // FLAG: Single-ID read barrier only. Never kill a foreign or ambiguous client.
        const raw = await redis.client('LIST', 'ID', String(identity.clientId));
        requireFact(
          typeof raw === 'string' && Buffer.byteLength(raw) <= QUEUE_LIMITS.outputBytes,
          'session_queue_old_client_unproved',
        );
        if (raw === '') return { clientId: identity.clientId, absent: true };
        const rows = raw.trim().split('\n'),
          fields = rows[0].split(' ');
        requireFact(
          rows.length === 1 &&
            fields.filter((field) => field.startsWith('id=')).join() ===
              `id=${identity.clientId}` &&
            fields.filter((field) => field.startsWith('name=')).join() ===
              `name=${identity.connectionName}`,
          'session_queue_old_identity_changed',
        );
        throw new Error('session_queue_old_client_present');
      }),
    readQueues: () =>
      run(async () => {
        const reply = await redis.eval_ro(scripts.queues, 0);
        requireFact(
          Buffer.byteLength(JSON.stringify(reply)) <= QUEUE_LIMITS.outputBytes &&
            Array.isArray(reply) &&
            reply.length === 2 &&
            reply[0] === 1 &&
            Array.isArray(reply[1]) &&
            reply[1].length === names.length,
          'session_queue_state_unproved',
        );
        return reply[1].map((row, index) => {
          requireFact(
            Array.isArray(row) &&
              row.length === 3 &&
              row[0] === names[index] &&
              Number.isSafeInteger(row[1]) &&
              row[1] >= 0 &&
              [0, 1].includes(row[2]),
            'session_queue_state_unproved',
          );
          return { name: row[0], active: row[1], paused: row[2] === 1 };
        });
      }),
    readWebhookFence: (nonce) =>
      run(async () => {
        const reply = await redis.eval_ro(scripts.fence, 0, ownerToken(nonce));
        requireFact(
          Array.isArray(reply) &&
            reply.length === 6 &&
            reply[0] === 1 &&
            reply[1] === 24 &&
            Number.isSafeInteger(reply[2]) &&
            reply[2] >= 0 &&
            reply[2] <= 24 &&
            Number.isSafeInteger(reply[3]) &&
            reply[3] >= 0 &&
            [0, 1].includes(reply[4]) &&
            [0, 1].includes(reply[5]) &&
            !(reply[5] === 1 && reply[4] === 0),
          'session_queue_fence_unproved',
        );
        return {
          queueCount: 24,
          pausedCount: reply[2],
          activeCount: reply[3],
          ownerPresent: reply[4] === 1,
          ownerMatches: reply[5] === 1,
        };
      }),
    pauseWebhookQueues: (nonce) => stock('pause', nonce),
    resumeWebhookQueues: (nonce) => stock('resume', nonce),
    pause: (name) => {
      const queue = selected(name);
      return run(() => queue.pause());
    },
    resume: (name) => {
      const queue = selected(name);
      return run(() => queue.resume());
    },
    close: async () => {
      if (closed) return;
      closed = true;
      poisoned = true;
      redis.disconnect();
      let timer;
      try {
        await Promise.race([
          Promise.allSettled([...queues.values()].map((queue) => queue.close())),
          new Promise((resolve) => {
            timer = setTimeout(resolve, QUEUE_LIMITS.operationMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
async function openQueueClient(redisUrl, { connectionName, queueNames } = {}) {
  requireFact(
    typeof redisUrl === 'string' &&
      redisUrl.length > 0 &&
      redisUrl.length <= 4096 &&
      namePattern.test(connectionName ?? ''),
    'session_queue_configuration_unproved',
  );
  registry(queueNames);
  const Redis = require('ioredis'),
    { Queue } = require('bullmq');
  const redis = new Redis(redisUrl, { ...CONNECTION_OPTIONS, connectionName });
  redis.on('error', () => {});
  redis.setMaxListeners(256);
  let client;
  try {
    await redis.connect();
    client = createQueueClient(redis, Queue, { queueNames });
    await client.ready();
    return client;
  } catch {
    if (client) await client.close();
    else redis.disconnect();
    throw new Error('session_queue_open_failed_closed');
  }
}

// FLAG: The host attests this exact registry from the pinned runtime and owns the
// durable baseline/journal. This adapter never deletes jobs, forces active work,
// restarts services or infers detached-handler absence from Redis counters.
function createSessionQueueAdapters({
  redisUrl,
  queueNames,
  manifest,
  connectionLedger,
  connectionName = `maxim-source-session:${manifest?.controllerNonce}`,
  openClient = openQueueClient,
  now = Date.now,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const names = registry(queueNames),
    auxiliary = names.filter((name) => !WEBHOOK_QUEUE_NAMES.includes(name));
  requireFact(
    manifest?.version === 1 &&
      noncePattern.test(manifest.controllerNonce ?? '') &&
      noncePattern.test(manifest.sessionId ?? '') &&
      hashPattern.test(manifest.registryDigest ?? '') &&
      connectionName === `maxim-source-session:${manifest.controllerNonce}` &&
      typeof connectionLedger?.read === 'function' &&
      typeof connectionLedger?.compareAndSet === 'function',
    'session_queue_context_unproved',
  );
  const manifestDigest = digest(manifest),
    nonce = manifest.controllerNonce;
  let clientPromise = null,
    establishedIdentity = null,
    closed = false;
  const parentProof = (value) => ({
    version: 1,
    complete: true,
    sessionId: manifest.sessionId,
    manifestDigest,
    ...value,
  });
  const checkManifest = (value) =>
    requireFact(digest(value) === manifestDigest, 'session_queue_manifest_changed');
  const validateBaseline = (value) => {
    requireFact(
      value?.version === 1 &&
        value.complete === true &&
        value.registryDigest === manifest.registryDigest &&
        value.queueCount === names.length &&
        value.ownerAbsent === true &&
        Array.isArray(value.queues) &&
        value.queues.length === names.length &&
        value.queues.every(
          (row, index) =>
            row?.name === names[index] &&
            typeof row.paused === 'boolean' &&
            Object.keys(row).sort().join(',') === 'name,paused',
        ) &&
        value.queues.every(
          (row) => !WEBHOOK_QUEUE_NAMES.includes(row.name) || row.paused === false,
        ),
      'session_queue_baseline_changed',
    );
    return value;
  };
  const ledgerCurrent = async () => {
    const current = exactIdentity(await connectionLedger.read(), connectionName);
    requireFact(
      digest(current) === digest(establishedIdentity),
      'session_queue_connection_ledger_changed',
    );
  };
  const client = () => {
    requireFact(!closed, 'session_queue_adapter_closed');
    if (!clientPromise)
      clientPromise = (async () => {
        let opened;
        try {
          opened = await openClient(redisUrl, { connectionName, queueNames: names });
          const previous = await connectionLedger.read();
          if (previous !== null) {
            exactIdentity(previous, connectionName);
            const absence = await opened.readOriginalClientAbsent(previous);
            requireFact(
              absence?.clientId === previous.clientId && absence.absent === true,
              'session_queue_old_client_unproved',
            );
          }
          establishedIdentity = exactIdentity(await opened.connectionIdentity(), connectionName);
          await connectionLedger.compareAndSet(
            previous === null ? null : digest(previous),
            establishedIdentity,
          );
          await ledgerCurrent();
          return opened;
        } catch (error) {
          if (opened) await opened.close();
          throw error;
        }
      })();
    return clientPromise;
  };
  async function call(deadline, method, ...args) {
    requireFact(Number.isSafeInteger(now()) && now() < deadline, 'session_queue_deadline');
    const queue = await client();
    await ledgerCurrent();
    const result = await queue[method](...args);
    await ledgerCurrent();
    requireFact(now() < deadline, 'session_queue_deadline');
    return result;
  }
  const owned = (value, requirePaused = true) => {
    requireFact(
      value.queueCount === 24 &&
        value.ownerPresent === true &&
        value.ownerMatches === true &&
        (!requirePaused || value.pausedCount === 24),
      'session_queue_ownership_lost',
    );
    return value;
  };
  async function pauseAll(value, baseline, deadline) {
    checkManifest(value);
    validateBaseline(baseline);
    await call(deadline, 'pauseWebhookQueues', nonce);
    owned(await call(deadline, 'readWebhookFence', nonce));
    const rows = await call(deadline, 'readQueues');
    for (const original of baseline.queues.filter((row) => auxiliary.includes(row.name))) {
      const current = rows.find((row) => row.name === original.name);
      requireFact(current && (!original.paused || current.paused), 'session_original_pause_lost');
      if (!original.paused && !current.paused) {
        owned(await call(deadline, 'readWebhookFence', nonce));
        await call(deadline, 'pause', original.name);
      }
    }
    owned(await call(deadline, 'readWebhookFence', nonce));
    const after = await call(deadline, 'readQueues');
    requireFact(
      after.every((row) => row.paused),
      'session_all_queue_pause_unproved',
    );
    return after;
  }
  return Object.freeze({
    async inspectQueueBaseline(value) {
      checkManifest(value);
      const deadline = now() + QUEUE_LIMITS.restoreMs;
      const before = await call(deadline, 'readWebhookFence', nonce);
      requireFact(!before.ownerPresent && before.pausedCount === 0, 'session_existing_queue_owner');
      const rows = await call(deadline, 'readQueues');
      const after = await call(deadline, 'readWebhookFence', nonce);
      requireFact(!after.ownerPresent && after.pausedCount === 0, 'session_existing_queue_owner');
      return validateBaseline({
        version: 1,
        complete: true,
        registryDigest: manifest.registryDigest,
        queueCount: names.length,
        queues: rows.map(({ name, paused }) => ({ name, paused })),
        ownerAbsent: true,
      });
    },
    async preDrainRuntime(value, baseline) {
      checkManifest(value);
      validateBaseline(baseline);
      const deadline = now() + QUEUE_LIMITS.drainMs;
      const fresh = await call(deadline, 'readQueues');
      requireFact(
        fresh.every((row, index) => row.paused === baseline.queues[index].paused),
        'session_queue_baseline_drift',
      );
      await pauseAll(value, baseline, deadline);
      let zeroObservations = 0;
      while (zeroObservations < 2) {
        owned(await call(deadline, 'readWebhookFence', nonce));
        const rows = await call(deadline, 'readQueues');
        requireFact(
          rows.every((row) => row.paused),
          'session_queue_pause_lost',
        );
        zeroObservations = rows.every((row) => row.active === 0) ? zeroObservations + 1 : 0;
        owned(await call(deadline, 'readWebhookFence', nonce));
        if (zeroObservations < 2) {
          requireFact(now() + QUEUE_LIMITS.pollMs < deadline, 'session_queue_drain_deadline');
          await wait(QUEUE_LIMITS.pollMs);
        }
      }
      return parentProof({
        queueCount: names.length,
        pausedCount: names.length,
        activeCount: 0,
        queueWorkDrained: true,
        zeroObservations: 2,
        ownerNonce: nonce,
      });
    },
    async restoreAuxiliaryQueues(value, baseline) {
      checkManifest(value);
      validateBaseline(baseline);
      const deadline = now() + QUEUE_LIMITS.restoreMs;
      const checkReleased = async () => {
        const fence = await call(deadline, 'readWebhookFence', nonce);
        requireFact(
          !fence.ownerPresent && !fence.ownerMatches && fence.pausedCount === 0,
          'session_stock_resume_required',
        );
      };
      await checkReleased();
      const rows = await call(deadline, 'readQueues');
      for (const original of baseline.queues.filter((row) => auxiliary.includes(row.name))) {
        const current = rows.find((row) => row.name === original.name);
        requireFact(current && (!original.paused || current.paused), 'session_original_pause_lost');
        if (!original.paused && current.paused) {
          await checkReleased();
          await call(deadline, 'resume', original.name);
        }
      }
      await checkReleased();
      const after = await call(deadline, 'readQueues');
      requireFact(
        after.every((row, index) => row.paused === baseline.queues[index].paused),
        'session_queue_restore_unproved',
      );
      return parentProof({ restored: true, queueBaselineDigest: digest(baseline) });
    },
    async pauseAllQueues(value, baseline) {
      return pauseAll(value, baseline, now() + QUEUE_LIMITS.restoreMs);
    },
    async pauseWebhookQueues(value) {
      checkManifest(value);
      return call(now() + QUEUE_LIMITS.restoreMs, 'pauseWebhookQueues', nonce);
    },
    async resumeWebhookQueues(value) {
      checkManifest(value);
      return call(now() + QUEUE_LIMITS.restoreMs, 'resumeWebhookQueues', nonce);
    },
    async readWebhookFence(value) {
      checkManifest(value);
      return call(now() + QUEUE_LIMITS.restoreMs, 'readWebhookFence', nonce);
    },
    async close() {
      closed = true;
      if (clientPromise) {
        try {
          await (await clientPromise).close();
        } catch {
          /* Original failure stays authoritative. */
        }
      }
    },
  });
}

module.exports = {
  CONNECTION_OPTIONS,
  QUEUE_LIMITS,
  isSupportedSourceAbandonmentQueueInventory,
  buildQueueReadScripts,
  createQueueClient,
  openQueueClient,
  createSessionQueueAdapters,
};
