import { RUNTIME_SERVICE_NAMES } from '../runtime/runtime-topology';
import { fleetBaselineCoverage } from './fleet-baseline-coverage';

function runtime() {
  return {
    available: true,
    services: RUNTIME_SERVICE_NAMES.filter((service) => service !== 'api-all').map((service) => ({
      service: String(service),
      snapshot: { webhookOutbox: {}, webhookPreparation: {} } as {
        webhookOutbox: unknown;
        webhookPreparation: unknown;
      } | null,
    })),
  };
}

describe('distributed fleet baseline coverage', () => {
  it('accepts fourteen fresh distributed roles without requiring api-all', () => {
    expect(fleetBaselineCoverage(runtime(), { available: true, countersPresent: 1 })).toMatchObject(
      { collectionReady: true, rolesFresh: true, missingRuntimeServices: [] },
    );
  });
  it('does not replace a missing distributed role with api-all', () => {
    const report = runtime();
    report.services[0]!.service = 'api-all';
    expect(fleetBaselineCoverage(report, { available: true, countersPresent: 1 })).toMatchObject({
      collectionReady: false,
      rolesFresh: false,
      missingRuntimeServices: ['api-message-retention'],
    });
  });
  it('keeps absent measurements and zero-or-missing counters as coverage gaps', () => {
    const report = runtime();
    report.services.find(({ service }) => service === 'api-enqueue')!.snapshot = {
      webhookOutbox: null,
      webhookPreparation: null,
    };
    expect(fleetBaselineCoverage(report, { available: true, countersPresent: 0 })).toMatchObject({
      collectionReady: false,
      rolesFresh: true,
      webhookOutbox: false,
      webhookPreparation: false,
      maxApiReadable: true,
      maxApiObserved: false,
    });
    expect(
      fleetBaselineCoverage({ available: false, services: [] }, { available: false }),
    ).toMatchObject({ collectionReady: false, rolesFresh: false, maxApiReadable: false });
  });
});
