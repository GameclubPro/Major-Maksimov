import assert from 'node:assert/strict';
import test from 'node:test';
import {
  initialObserverModel,
  inspectObserverSnapshot,
  observeRuntime,
  recoverObserverModel,
} from './local-observer-model.mjs';
import { makeObserverSnapshot } from './local-observer-test-fixture.mjs';

const START = Date.parse('2026-11-04T06:00:00.000Z');
const iso = (now) => new Date(now).toISOString();
let identity = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++identity).padStart(12, '0')}`;
const unavailable = () => ({ availability: 'UNAVAILABLE', observedAt: null, value: null });

function snapshot(now, change = () => {}) {
  const value = makeObserverSnapshot(now);
  change(value, now);
  return value;
}

function delayed(now) {
  return snapshot(now, (value) => {
    for (const row of [value.receipts, value.bots[0].pendingReceipts]) {
      row.value.countLowerBound = 1;
      row.value.oldestAgeMs = 31000;
    }
  });
}

function poll(model, offset, read = delayed) {
  const now = START + offset;
  return observeRuntime(model, read === null ? null : read(now), now, { uuid });
}

function sequence(model, from, through, read = delayed) {
  for (let offset = from; offset <= through; offset += 15000) model = poll(model, offset, read);
  return model;
}

function problem() {
  return sequence(initialObserverModel(), 0, 120000);
}

test('fresh quiet bots and an idle configured Publisher do not require recent incoming messages', () => {
  const value = makeObserverSnapshot(START);
  assert.ok(
    value.bots
      .filter((bot) => bot.kind === 'moderator')
      .every((bot) => bot.subscription.value.lastIncomingAt === null),
  );
  assert.equal(value.bots[2].subscription.value, null);
  const evidence = inspectObserverSnapshot(value, START);
  assert.equal(evidence.complete, true);
  assert.equal(evidence.critical, false);
  assert.deepEqual(evidence.reasons, []);
  assert.deepEqual(evidence.counts, {
    affectedBots: 0,
    totalBots: 3,
    pending: 0,
    oldestPendingAgeMs: 0,
  });
});

test('warning delays and the exact 30-second boundary do not trigger critical mail', () => {
  for (const age of [10000, 10001, 30000, 30001]) {
    const value = snapshot(START, (row) => {
      row.receipts.value.countLowerBound = 1;
      row.receipts.value.oldestAgeMs = age;
      row.actions.value.sampleCount = 1;
      row.actions.value.latency = { sampleCount: 1, p50Ms: age, p95Ms: age, p99Ms: age };
    });
    const evidence = inspectObserverSnapshot(value, START);
    assert.equal(evidence.complete, true);
    assert.equal(evidence.critical, age > 30000, `age=${age}`);
    assert.deepEqual(evidence.reasons, age > 30000 ? ['ACTION_LATENCY', 'RECEIPT_DELAY'] : []);
  }
});

test('each active/draining moderator and configured Publisher contributes its own delay and latency evidence', () => {
  for (const botIndex of [0, 1, 2]) {
    for (const field of ['pendingReceipts', 'actionLatency']) {
      const value = snapshot(START, (row) => {
        const bot = row.bots[botIndex];
        if (field === 'pendingReceipts') {
          bot.pendingReceipts.value.countLowerBound = 1;
          bot.pendingReceipts.value.oldestAgeMs = 30001;
        } else {
          bot.actionLatency.value = { sampleCount: 1, p50Ms: 1000, p95Ms: 30001, p99Ms: 35000 };
        }
      });
      const evidence = inspectObserverSnapshot(value, START);
      assert.equal(evidence.complete, true, `${botIndex}/${field}`);
      assert.equal(evidence.critical, true);
      assert.equal(evidence.counts.affectedBots, 1);
      assert.equal(evidence.counts.totalBots, 3);
      assert.deepEqual(evidence.reasons, [
        field === 'pendingReceipts' ? 'RECEIPT_DELAY' : 'ACTION_LATENCY',
      ]);
    }
  }
});

test('inactive moderator rows do not turn an intentionally dormant bot into an incident', () => {
  for (const state of ['disabled', 'dormant', 'configured']) {
    const value = snapshot(START, (row) => {
      const bot = row.bots[0];
      bot.state = state;
      bot.subscription = unavailable();
      bot.pendingReceipts = unavailable();
      bot.actionLatency = unavailable();
      bot.unfinishedActions = unavailable();
    });
    const evidence = inspectObserverSnapshot(value, START);
    assert.equal(evidence.complete, true);
    assert.equal(evidence.critical, false);
    assert.equal(evidence.counts.totalBots, 2);
  }
});

test('positive pending work with unknown age or wrong age basis remains partial without healthy zeros', () => {
  for (const botIndex of [null, 0, 1, 2]) {
    for (const unknown of ['age', 'basis']) {
      const value = snapshot(START, (row) => {
        const pending = botIndex === null ? row.receipts : row.bots[botIndex].pendingReceipts;
        pending.value.countLowerBound = 1;
        pending.value.oldestAgeMs = unknown === 'age' ? null : 31000;
        if (unknown === 'basis') pending.value.ageBasis = 'state_updated_sample';
      });
      const evidence = inspectObserverSnapshot(value, START);
      assert.equal(evidence.complete, false);
      assert.equal(evidence.critical, false);
      assert.deepEqual(evidence.reasons, ['PARTIAL_OBSERVATION']);
      if (botIndex === null) assert.equal(Object.hasOwn(evidence, 'counts'), false);
      else assert.equal(evidence.counts.affectedBots, 1);
    }
  }
});

test('truncated global and per-bot samples block complete health even when their lower bound is zero', () => {
  const selectors = [
    (row) => row.receipts,
    (row) => row.actions,
    (row) => row.unfinishedActions,
    ...[0, 1, 2].flatMap((index) => [
      (row) => row.bots[index].pendingReceipts,
      (row) => row.bots[index].unfinishedActions,
    ]),
  ];
  for (const select of selectors) {
    const evidence = inspectObserverSnapshot(
      snapshot(START, (row) => {
        select(row).value.sampleComplete = false;
      }),
      START,
    );
    assert.equal(evidence.complete, false);
    assert.ok(evidence.reasons.includes('PARTIAL_OBSERVATION'));
  }
});

test('unknown or old unfinished work blocks healthy p95 without inventing execution latency', () => {
  for (const botIndex of [null, 0, 1, 2]) {
    for (const age of [null, 30001]) {
      const value = snapshot(START, (row) => {
        const unfinished =
          botIndex === null ? row.unfinishedActions : row.bots[botIndex].unfinishedActions;
        unfinished.value.countLowerBound = 1;
        unfinished.value.oldestAgeMs = age;
        row.actions.value.sampleCount = 1;
        row.actions.value.latency = { sampleCount: 1, p50Ms: 1000, p95Ms: 1000, p99Ms: 1000 };
      });
      const evidence = inspectObserverSnapshot(value, START);
      assert.equal(evidence.complete, false);
      assert.equal(evidence.critical, false);
      assert.deepEqual(evidence.reasons, ['PARTIAL_OBSERVATION']);
    }
  }
});

test('stale or missing collector, queue, action, receipt and per-bot observations never prove health', () => {
  const sources = [
    { select: (row) => row.queues, ttl: 25000 },
    { select: (row) => row.receipts, ttl: 65000 },
    { select: (row) => row.actions, ttl: 65000 },
    { select: (row) => row.unfinishedActions, ttl: 65000 },
    ...[0, 1, 2].flatMap((index) => [
      { select: (row) => row.bots[index].pendingReceipts, ttl: 65000 },
      { select: (row) => row.bots[index].actionLatency, ttl: 65000 },
      { select: (row) => row.bots[index].unfinishedActions, ttl: 65000 },
    ]),
    ...[0, 1].map((index) => ({ select: (row) => row.bots[index].subscription, ttl: 150000 })),
  ];
  for (const { select, ttl } of sources) {
    for (const change of [
      (row) => {
        row.observedAt = iso(START - ttl);
      },
      (row) => {
        row.observedAt = iso(START + 5001);
      },
      (row) => {
        Object.assign(row, unavailable());
      },
      (row) => {
        row.availability = 'STALE';
      },
    ]) {
      const evidence = inspectObserverSnapshot(
        snapshot(START, (row) => change(select(row))),
        START,
      );
      assert.equal(evidence.complete, false);
      assert.ok(evidence.reasons.includes('PARTIAL_OBSERVATION'));
    }
  }
  for (const observedAt of [iso(START - 25000), iso(START + 5001), null]) {
    const evidence = inspectObserverSnapshot(
      makeObserverSnapshot(START, { collector: { observedAt } }),
      START,
    );
    assert.equal(evidence.sourceAt, null);
    assert.equal(evidence.complete, false);
    assert.equal(evidence.critical, false);
    assert.deepEqual(evidence.reasons, ['STALE_OBSERVATION']);
  }
});

test('worker fleet checks each role timestamp using its 90-second heartbeat lifetime', () => {
  const value = snapshot(START, (row) => {
    row.workers.value.rows[0].observedAt = iso(START - 89999);
  });
  assert.equal(inspectObserverSnapshot(value, START).complete, true);
  for (const change of [
    (row) => {
      row.workers.value.rows[0].observedAt = iso(START - 90000);
    },
    (row) => {
      row.workers.value.rows[0].observedAt = null;
    },
    (row) => {
      row.workers.value.rows[0].observedAt = iso(START + 5001);
    },
    (row) => {
      row.workers.value.freshCount = 1;
    },
    (row) => {
      row.workers.value.rows.pop();
    },
    (row) => {
      row.workers.value.rows[1].service = row.workers.value.rows[0].service;
    },
    (row) => {
      row.workers.observedAt = iso(START - 25000);
    },
    (row) => {
      row.workers = unavailable();
    },
    (row) => {
      row.workers.value = { expectedCount: 0, freshCount: 0, rows: [] };
    },
  ]) {
    const evidence = inspectObserverSnapshot(snapshot(START, change), START);
    assert.equal(evidence.complete, false);
    assert.ok(evidence.reasons.includes('WORKER_OBSERVATION_MISSING'));
  }
});

test('every operational moderator subscription must be configured and connected', () => {
  for (const botIndex of [0, 1]) {
    for (const field of ['configured', 'subscribed']) {
      const evidence = inspectObserverSnapshot(
        snapshot(START, (row) => {
          row.bots[botIndex].subscription.value[field] = false;
        }),
        START,
      );
      assert.equal(evidence.complete, true);
      assert.equal(evidence.critical, true);
      assert.equal(evidence.counts.affectedBots, 1);
      assert.deepEqual(evidence.reasons, ['BOT_DISCONNECTED']);
    }
  }
});

test('a configured Publisher requires its own fresh heartbeat even when the worker fleet is fresh', () => {
  for (const change of [
    (bot) => {
      bot.publisher = null;
    },
    (bot) => {
      bot.publisher = unavailable();
    },
    (bot) => {
      bot.publisher.observedAt = iso(START - 45000);
    },
    (bot) => {
      bot.publisher.observedAt = iso(START + 5001);
    },
  ]) {
    const evidence = inspectObserverSnapshot(
      snapshot(START, (row) => change(row.bots[2])),
      START,
    );
    assert.equal(evidence.complete, false);
    assert.equal(evidence.critical, false);
    assert.equal(evidence.counts.affectedBots, 1);
    assert.ok(evidence.reasons.includes('WORKER_OBSERVATION_MISSING'));
  }
});

test('intentional Publisher pauses are idle only with complete fresh absence of pending and unfinished work', () => {
  for (const blocker of ['runtime_disabled', 'global_paused']) {
    const paused = (now) =>
      snapshot(now, (row) => {
        row.bots[2].publisher.value = { dispatchEnabled: false, blocker };
        row.bots[2].subscription = unavailable();
      });
    assert.equal(inspectObserverSnapshot(paused(START), START).complete, true);
    assert.equal(inspectObserverSnapshot(paused(START), START).critical, false);
    for (const field of ['pendingReceipts', 'unfinishedActions']) {
      const value = paused(START);
      value.bots[2][field].value.countLowerBound = 1;
      value.bots[2][field].value.oldestAgeMs = 1000;
      const evidence = inspectObserverSnapshot(value, START);
      assert.equal(evidence.complete, true);
      assert.equal(evidence.critical, true);
      assert.deepEqual(evidence.reasons, ['CRITICAL_RUNTIME']);
    }
    for (const change of [
      (bot) => {
        bot.pendingReceipts.value.sampleComplete = false;
      },
      (bot) => {
        bot.unfinishedActions = unavailable();
      },
    ]) {
      const value = paused(START);
      change(value.bots[2]);
      const evidence = inspectObserverSnapshot(value, START);
      assert.equal(evidence.complete, false);
      assert.ok(evidence.reasons.includes('PARTIAL_OBSERVATION'));
    }
  }
});

test('Publisher identity or unknown blockers require attention even without queued work', () => {
  for (const blocker of ['identity_unattested', 'unknown', null, 'unrecognized']) {
    const evidence = inspectObserverSnapshot(
      snapshot(START, (row) => {
        row.bots[2].publisher.value = { dispatchEnabled: false, blocker };
      }),
      START,
    );
    assert.equal(evidence.complete, true);
    assert.equal(evidence.critical, true);
    assert.deepEqual(evidence.reasons, ['CRITICAL_RUNTIME']);
    assert.equal(evidence.counts.affectedBots, 1);
  }
  const inconsistent = inspectObserverSnapshot(
    snapshot(START, (row) => {
      row.bots[2].publisher.value.blocker = 'identity_unattested';
    }),
    START,
  );
  assert.equal(inconsistent.complete, false);
});

test('critical notification requires two minutes of both local time and advancing metric evidence', () => {
  let model = sequence(initialObserverModel(), 0, 105000);
  assert.equal(model.events.length, 0);
  const before = structuredClone(model);
  model = poll(model, 120000);
  assert.deepEqual(before.events, []);
  assert.equal(model.events.length, 1);
  assert.equal(model.events[0].event.kind, 'PROBLEM');
  assert.equal(model.events[0].event.startedAt, iso(START));
  assert.equal(model.events[0].event.observedAt, iso(START + 120000));
  assert.deepEqual(model.events[0].event.reasonCodes, ['RECEIPT_DELAY']);
  const lagging = (now) => {
    const value = delayed(now);
    for (const row of [value.receipts, value.bots[0].pendingReceipts])
      row.observedAt = iso(Math.min(now, START + 105000));
    return value;
  };
  model = sequence(initialObserverModel(), 0, 120000, lagging);
  assert.equal(model.events.length, 0);
  model = poll(model, 135000);
  assert.equal(model.events.length, 1);
});

test('a fresh Publisher blocker must persist through the same two-minute confirmation window', () => {
  const blocked = (now) =>
    snapshot(now, (row) => {
      row.bots[2].publisher.value = { dispatchEnabled: false, blocker: 'identity_unattested' };
    });
  let model = sequence(initialObserverModel(), 0, 105000, blocked);
  assert.equal(model.events.length, 0);
  model = poll(model, 120000, blocked);
  assert.deepEqual(model.events[0].event.reasonCodes, ['CRITICAL_RUNTIME']);
});

test('a missing or partial poll interrupts critical confirmation rather than joining separated windows', () => {
  for (const interruption of [
    null,
    (now) => {
      const value = delayed(now);
      value.actions.value.sampleComplete = false;
      return value;
    },
  ]) {
    let model = sequence(initialObserverModel(), 0, 45000);
    model = poll(model, 60000, interruption);
    assert.equal(model.candidate, null);
    model = sequence(model, 75000, 180000);
    assert.equal(model.events.length, 0);
    assert.equal(model.candidate.since, iso(START + 75000));
    model = poll(model, 195000);
    assert.equal(model.events.length, 1);
  }
});

test('a polling gap resets critical and lost-observation confirmation without fabricating missing samples', () => {
  let model = sequence(initialObserverModel(), 0, 15000);
  model = poll(model, 75000);
  assert.equal(model.candidate.since, iso(START + 75000));
  model = sequence(model, 90000, 180000);
  assert.equal(model.events.length, 0);
  assert.equal(poll(model, 195000).events.length, 1);
  model = sequence(initialObserverModel(), 0, 15000, null);
  model = poll(model, 600000, null);
  assert.equal(model.events.length, 0);
  assert.equal(model.degradedSince, iso(START + 600000));
});

test('collector time rollback interrupts confirmation and does not advance the successful sample marker', () => {
  let model = sequence(initialObserverModel(), 0, 30000);
  const previousSuccess = model.lastSuccessfulSampleAt;
  model = poll(model, 45000, (now) => {
    const value = delayed(now);
    value.collector.observedAt = iso(START + 25000);
    return value;
  });
  assert.equal(model.candidate, null);
  assert.equal(model.lastSuccessfulSampleAt, previousSuccess);
  assert.equal(model.lastSourceObservedAt, iso(START + 30000));
  model = sequence(model, 60000, 165000);
  assert.equal(model.events.length, 0);
  assert.equal(poll(model, 180000).events.length, 1);
});

test('critical metric time rollback restarts its source evidence window despite a fresh collector', () => {
  let model = sequence(initialObserverModel(), 0, 30000);
  model = poll(model, 45000, (now) => {
    const value = delayed(now);
    value.receipts.observedAt = iso(START + 20000);
    value.bots[0].pendingReceipts.observedAt = iso(START + 20000);
    return value;
  });
  assert.equal(model.candidate.since, iso(START + 45000));
  assert.equal(model.candidate.firstEvidenceAt, iso(START + 20000));
  model = sequence(model, 60000, 150000);
  assert.equal(model.events.length, 0);
  assert.equal(poll(model, 165000).events.length, 1);
});

test('repeated source snapshots cannot establish sustained runtime evidence and eventually become stale observations', () => {
  const frozen = delayed(START);
  let model = sequence(initialObserverModel(), 0, 120000, () => frozen);
  assert.equal(model.events.length, 0);
  assert.equal(model.candidate, null);
  assert.equal(model.lastSuccessfulSampleAt, iso(START));
  assert.equal(model.degradedSince, iso(START + 30000));
  model = sequence(model, 135000, 150000, () => frozen);
  assert.equal(model.events.length, 1);
  assert.deepEqual(model.events[0].event.reasonCodes, ['STALE_OBSERVATION']);
});

test('prolonged missing, stale, partial and missing-worker observations each create one problem', () => {
  for (const [read, reason] of [
    [null, 'OBSERVATION_LOST'],
    [
      (now) => makeObserverSnapshot(now, { collector: { availability: 'STALE' } }),
      'STALE_OBSERVATION',
    ],
    [
      (now) => makeObserverSnapshot(now, { actions: { value: { sampleComplete: false } } }),
      'PARTIAL_OBSERVATION',
    ],
    [
      (now) =>
        snapshot(now, (row) => {
          row.workers.value.rows[0].observedAt = null;
        }),
      'WORKER_OBSERVATION_MISSING',
    ],
  ]) {
    let model = sequence(initialObserverModel(), 0, 105000, read);
    assert.equal(model.events.length, 0);
    model = poll(model, 120000, read);
    assert.equal(model.events.length, 1);
    assert.ok(model.events[0].event.reasonCodes.includes(reason));
    model = sequence(model, 135000, 600000, read);
    assert.equal(model.events.length, 1);
  }
});

test('a complete sample interrupts loss confirmation even when previous requests failed', () => {
  let model = sequence(initialObserverModel(), 0, 105000, null);
  model = poll(model, 120000, makeObserverSnapshot);
  assert.equal(model.degradedSince, null);
  model = sequence(model, 135000, 240000, null);
  assert.equal(model.events.length, 0);
  model = poll(model, 255000, null);
  assert.equal(model.events.length, 1);
  assert.equal(model.events[0].event.startedAt, iso(START + 135000));
});

test('unreported pending and proved-rejected problems are suppressed when fresh complete health returns', () => {
  for (const state of ['PENDING', 'REJECTED']) {
    let model = problem();
    model.events[0].state = state;
    if (state === 'REJECTED') model.events[0].attempts = 3;
    model = poll(model, 135000, makeObserverSnapshot);
    assert.equal(model.incident, null);
    assert.equal(model.events.length, 1);
    assert.equal(model.events[0].state, 'SUPPRESSED');
    model = poll(model, 150000, makeObserverSnapshot);
    assert.equal(model.events.length, 1);
  }
});

test('sent or uncertain problems get one recovery and a later incident keeps a separate identity', () => {
  for (const state of ['SENT', 'UNCERTAIN']) {
    let model = problem();
    model.events[0].state = state;
    model.events[0].attempts = 1;
    const firstIncident = model.incident.id;
    model = sequence(model, 135000, 180000);
    assert.equal(model.events.length, 1);
    model = poll(model, 195000, makeObserverSnapshot);
    assert.equal(model.incident, null);
    assert.equal(model.events.length, 2);
    assert.equal(model.events[0].state, state);
    assert.equal(model.events[1].event.kind, 'RECOVERY');
    assert.deepEqual(model.events[1].event.reasonCodes, model.events[0].event.reasonCodes);
    assert.equal(model.events[1].event.startedAt, model.events[0].event.startedAt);
    model = poll(model, 210000, makeObserverSnapshot);
    assert.equal(model.events.length, 2);
    model = sequence(model, 225000, 345000);
    assert.equal(model.events.length, 3);
    assert.equal(model.events[2].event.kind, 'PROBLEM');
    assert.notEqual(model.incident.id, firstIncident);
    assert.equal(new Set(model.events.map((row) => row.event.id)).size, 3);
  }
});

test('old unfinished work, unknown pending age and missing observations block recovery despite a good p95', () => {
  for (const read of [
    null,
    (now) =>
      snapshot(now, (row) => {
        row.unfinishedActions.value.countLowerBound = 1;
        row.unfinishedActions.value.oldestAgeMs = 31000;
      }),
    (now) =>
      snapshot(now, (row) => {
        row.bots[1].unfinishedActions.value.countLowerBound = 1;
        row.bots[1].unfinishedActions.value.oldestAgeMs = 31000;
      }),
    (now) =>
      snapshot(now, (row) => {
        row.receipts.value.countLowerBound = 1;
      }),
  ]) {
    let model = problem();
    model.events[0].state = 'SENT';
    model = sequence(model, 135000, 300000, read);
    assert.notEqual(model.incident, null);
    assert.equal(model.events.length, 1);
    model = poll(model, 315000, makeObserverSnapshot);
    assert.equal(model.events.length, 2);
    assert.equal(model.events[1].event.kind, 'RECOVERY');
  }
});

test('restart breaks confirmation, quarantines sending uncertainty and retains all delivery evidence', () => {
  let model = sequence(initialObserverModel(), 0, 105000);
  model = recoverObserverModel(model);
  assert.equal(model.candidate, null);
  assert.equal(model.degradedSince, null);
  model = sequence(model, 120000, 225000);
  assert.equal(model.events.length, 0);
  model = poll(model, 240000);
  assert.equal(model.events.length, 1);
  model.events[0].state = 'SENDING';
  model.events[0].attempts = 1;
  const saved = structuredClone(model);
  assert.throws(() => poll(model, 255000, makeObserverSnapshot), /OBSERVER_DELIVERY_STILL_ACTIVE/u);
  assert.deepEqual(model, saved);
  const recovered = recoverObserverModel(model);
  assert.deepEqual(model, saved);
  assert.equal(recovered.events[0].state, 'UNCERTAIN');
  assert.equal(recovered.events[0].outcomeCode, 'OBSERVER_RESTART_DURING_SEND');
  assert.equal(recovered.events[0].event.id, saved.events[0].event.id);
  assert.deepEqual(recovered.incident, saved.incident);
  const healthy = poll(recovered, 255000, makeObserverSnapshot);
  assert.equal(healthy.events.length, 2);
  assert.equal(healthy.events[0].state, 'UNCERTAIN');
  assert.equal(healthy.events[1].event.kind, 'RECOVERY');
  assert.deepEqual(recoverObserverModel(healthy).events, healthy.events);
});

test('invalid or backwards local clocks fail without changing retained state', () => {
  const model = poll(initialObserverModel(), 15000);
  const saved = structuredClone(model);
  for (const now of [NaN, Infinity, -Infinity])
    assert.throws(() => observeRuntime(model, null, now), { code: 'OBSERVER_CLOCK_INVALID' });
  assert.throws(() => poll(model, 14999), { code: 'OBSERVER_CLOCK_MOVED_BACKWARDS' });
  assert.deepEqual(model, saved);
});

test('ledger capacity fails closed without pruning uncertain evidence', () => {
  let model = initialObserverModel();
  model.events = Array.from({ length: 256 }, () => ({
    event: {
      id: uuid(),
      kind: 'PROBLEM',
      startedAt: iso(START - 120000),
      observedAt: iso(START),
      reasonCodes: ['OBSERVATION_LOST'],
    },
    state: 'UNCERTAIN',
    attempts: 1,
    nextAttemptAt: null,
    outcomeCode: 'SMTP_OUTCOME_UNKNOWN',
  }));
  model = sequence(model, 0, 105000, null);
  const saved = structuredClone(model);
  assert.throws(() => poll(model, 120000, null), { code: 'OBSERVER_EVENT_CAPACITY' });
  assert.deepEqual(model, saved);
  assert.equal(model.events.length, 256);
  assert.ok(model.events.every((row) => row.state === 'UNCERTAIN'));
});
