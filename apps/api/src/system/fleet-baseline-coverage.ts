import { RUNTIME_SERVICE_NAMES } from '../runtime/runtime-topology';

type RuntimeCoverage = {
  available: boolean;
  services: readonly {
    service: string;
    snapshot: { webhookOutbox: unknown; webhookPreparation: unknown } | null;
  }[];
};

// FLAG: Production uses the fourteen distributed roles; api-all cannot replace
// missing role observations. Fresh roles and measured work are separate evidence.
export function fleetBaselineCoverage(
  runtime: RuntimeCoverage,
  maxApi: { available: boolean; countersPresent?: number },
) {
  const missingRuntimeServices = RUNTIME_SERVICE_NAMES.filter(
    (service) =>
      service !== 'api-all' &&
      !runtime.services.some((entry) => entry.service === service && entry.snapshot),
  );
  const enqueue = runtime.services.find(({ service }) => service === 'api-enqueue')?.snapshot;
  const rolesFresh = runtime.available && missingRuntimeServices.length === 0;
  const webhookOutbox = enqueue?.webhookOutbox != null;
  const webhookPreparation = enqueue?.webhookPreparation != null;
  const maxApiObserved = maxApi.available && (maxApi.countersPresent ?? 0) > 0;
  return {
    rolesFresh,
    missingRuntimeServices,
    webhookOutbox,
    webhookPreparation,
    maxApiReadable: maxApi.available,
    maxApiObserved,
    collectionReady: rolesFresh && webhookOutbox && webhookPreparation && maxApiObserved,
  };
}
