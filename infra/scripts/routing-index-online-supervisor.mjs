#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import {
  createRoutingIndexOnlineClientLauncher,
  createSpammerProjectionOnlineClientLauncher,
} from './multibot-online-client.mjs';
import { installMultibotOutputFence } from './multibot-online-supervisor.mjs';
import { prepareOutcomeCohortIndexes } from './outcome-cohort-online-supervisor.mjs';
import { readRoutingIndexState } from './routing-index-online-state.mjs';
import {
  checkRoutingIndexPrepareCapacity,
  checkSpammerProjectionPrepareCapacity,
  readSpammerProjectionPrepareState,
  validateSpammerReleaseIdentity,
} from './routing-index-prepare-capacity.mjs';

export function routingIndexFailureCode(error) {
  const message = error?.message ?? '';
  if (/^ROUTING_INDEX_[A-Z_]+$/u.test(message)) return message;
  if (/^OUTCOME_COHORT_[A-Z_]+$/u.test(message))
    return message.replace(/^OUTCOME_COHORT_/u, 'ROUTING_INDEX_');
  if (/^MULTIBOT_PREPARE_[A-Z_]+$/u.test(message)) return message;
  return 'ROUTING_INDEX_PREPARATION_FAILED';
}

export async function prepareRoutingIndex(composeArgs, options = {}) {
  return prepareOutcomeCohortIndexes(composeArgs, {
    ...options,
    readState: options.readState ?? readRoutingIndexState,
    checkCapacity: options.checkCapacity ?? checkRoutingIndexPrepareCapacity,
    createLauncher: options.createLauncher ?? createRoutingIndexOnlineClientLauncher,
    stage: 'routing_index_prepare',
    failureCode: routingIndexFailureCode,
  });
}

export async function prepareSpammerProjection(sha, composeArgs, options = {}) {
  const env = options.env ?? process.env;
  validateSpammerReleaseIdentity(sha, env);
  return prepareOutcomeCohortIndexes(composeArgs, {
    ...options,
    readState: (args, stateOptions) =>
      readSpammerProjectionPrepareState(sha, args, {
        ...stateOptions,
        env,
        readReleaseState: options.readReleaseState,
      }),
    checkCapacity: (args, capacityOptions) =>
      (options.checkCapacity ?? checkSpammerProjectionPrepareCapacity)(sha, args, {
        ...capacityOptions,
        env,
        readReleaseState: options.readReleaseState,
      }),
    createLauncher: options.createLauncher ?? createSpammerProjectionOnlineClientLauncher,
    stage: 'spammer_projection_prepare',
    failureCode: routingIndexFailureCode,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const uninstall = installMultibotOutputFence();
  try {
    const [mode, ...args] = process.argv.slice(2);
    if (mode === 'preflight') {
      const result = await checkRoutingIndexPrepareCapacity(args);
      console.log(JSON.stringify({ stage: 'routing_index_preflight', ...result }));
    } else if (mode === 'prepare') {
      await prepareRoutingIndex(args, {
        onProgress: (event) => console.log(JSON.stringify(event)),
      });
    } else if (mode === 'preflight-spammer' || mode === 'prepare-spammer') {
      const [sha, ...composeArgs] = args;
      if (mode === 'preflight-spammer') {
        const result = await checkSpammerProjectionPrepareCapacity(sha, composeArgs);
        console.log(JSON.stringify({ stage: 'spammer_projection_preflight', ...result }));
      } else {
        await prepareSpammerProjection(sha, composeArgs, {
          onProgress: (event) => console.log(JSON.stringify(event)),
        });
      }
    } else throw new Error('ROUTING_INDEX_ARGUMENTS_INVALID');
  } catch (error) {
    console.error(
      `${routingIndexFailureCode(error)}; old roles remain live; receipts and indexes preserved.`,
    );
    process.exitCode = 1;
  } finally {
    uninstall();
  }
}
