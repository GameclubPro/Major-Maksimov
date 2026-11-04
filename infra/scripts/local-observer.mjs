#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  readObserverConfiguration,
  initializeObserverConfiguration,
  ensureObserverStateDirectory,
} from './local-observer-config.mjs';
import { observerFailure } from './local-observer-files.mjs';
import { observeRuntime, recoverObserverModel, OBSERVER_TIMING } from './local-observer-model.mjs';
import { ObserverStore, deliverObserverEvent, readObserverState } from './local-observer-state.mjs';
import { sendObserverMail } from './local-observer-mail.mjs';

export async function readObserverSnapshot(config, schema, { fetcher = fetch, signal } = {}) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await fetcher(config.overviewUrl, {
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      headers: {
        authorization:
          'Basic ' +
          Buffer.from(config.reader.basicUsername + ':' + config.reader.basicPassword).toString(
            'base64',
          ),
        'x-runtime-overview-reader-token': config.reader.token,
        accept: 'application/json',
        'cache-control': 'no-cache',
      },
    });
    if (
      !response.ok ||
      !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')
    )
      observerFailure('OBSERVER_SAMPLE_UNAVAILABLE');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 250000) observerFailure('OBSERVER_SAMPLE_OVERSIZED');
      chunks.push(chunk);
    }
    const value = schema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))),
    );
    if (
      value.history.availability !== 'UNAVAILABLE' ||
      value.history.observedAt !== null ||
      value.history.points.length !== 0
    )
      observerFailure('OBSERVER_MACHINE_CONTRACT_INVALID');
    return value;
  } catch {
    observerFailure('OBSERVER_SAMPLE_UNAVAILABLE');
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
}

export function observerStatus(model, now = Date.now()) {
  return {
    schemaVersion: 1,
    observedAt: new Date(now).toISOString(),
    heartbeatAt: model.lastPollAt,
    lastSuccessfulSampleAt: model.lastSuccessfulSampleAt,
    sourceObservedAt: model.lastSourceObservedAt,
    heartbeatFresh:
      model.lastPollAt !== null &&
      now - Date.parse(model.lastPollAt) >= 0 &&
      now - Date.parse(model.lastPollAt) <= OBSERVER_TIMING.pollGapMs,
    incidentActive: model.incident !== null,
    criticalSince: model.candidate?.since ?? null,
    observationsDegradedSince: model.degradedSince,
    deliveries: Object.fromEntries(
      ['PENDING', 'SENDING', 'SENT', 'REJECTED', 'UNCERTAIN', 'SUPPRESSED'].map((state) => [
        state,
        model.events.filter((row) => row.state === state).length,
      ]),
    ),
  };
}

export async function runObserver(
  config,
  schema,
  {
    signal,
    store = new ObserverStore(ensureObserverStateDirectory(config)),
    readSnapshot = readObserverSnapshot,
    readConfiguration = readObserverConfiguration,
    sendMail = sendObserverMail,
    clock = Date.now,
    pause = delay,
  } = {},
) {
  store.lock();
  try {
    let model = recoverObserverModel(store.read());
    store.write(model);
    while (!signal?.aborted) {
      const started = clock();
      let snapshot = null;
      try {
        snapshot = await readSnapshot(config, schema, { signal });
      } catch {
        // FLAG: Missing observations reset runtime confirmation; they never become healthy zeros.
      }
      if (signal?.aborted) break;
      model = observeRuntime(model, snapshot, clock());
      store.write(model);
      // FLAG: Missing SMTP configuration is not a delivery attempt. Preserve pending events
      // until configuration recovers or a healthy sample suppresses the unreported incident.
      const current = readConfiguration(config.directory);
      if (current.smtpConfigured && !signal?.aborted)
        model = await deliverObserverEvent(
          model,
          store,
          (event) => sendMail({ smtp: current.smtp, event }),
          clock(),
        );
      if (signal?.aborted) break;
      try {
        await pause(Math.max(1, OBSERVER_TIMING.pollMs - (clock() - started)), undefined, {
          signal,
        });
      } catch {
        if (!signal?.aborted) observerFailure('OBSERVER_TIMER_FAILED');
      }
    }
  } finally {
    store.close();
  }
}

export async function observerMain(args) {
  if (args.length < 1 || args.length > 2 || !['init', 'check', 'status', 'run'].includes(args[0]))
    observerFailure('OBSERVER_USAGE');
  const directory = args[1];
  if (args[0] === 'init') return initializeObserverConfiguration(directory);
  const config = readObserverConfiguration(directory);
  if (args[0] === 'check')
    return {
      schemaVersion: 1,
      configuration: 'VALID',
      smtpConfigured: config.smtpConfigured,
      recipient: config.smtp.to,
    };
  if (args[0] === 'status')
    return {
      ...observerStatus(readObserverState(config.stateDirectory)),
      smtpConfigured: config.smtpConfigured,
    };
  let schema;
  try {
    ({ safetyDeskOverviewResponseSchema: schema } = await import('@maxim/contracts/safety-desk'));
  } catch {
    observerFailure('OBSERVER_CONTRACT_BUILD_REQUIRED');
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await runObserver(config, schema, { signal: controller.signal });
    return { schemaVersion: 1, status: 'STOPPED' };
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(JSON.stringify(await observerMain(process.argv.slice(2))) + '\n');
  } catch (error) {
    const code = /^OBSERVER_[A-Z0-9_]{1,64}$/u.test(error.code ?? '')
      ? error.code
      : 'OBSERVER_UNAVAILABLE';
    process.stderr.write(code + '\n');
    process.exitCode = 1;
  }
}
