import {
  OUTCOME_COHORT_HISTORICAL_COMPATIBILITY,
  isCompatibleHistoricalReceipt,
} from '../../scripts/agent/outcome-cohort-historical-compatibility.mjs';

export function validateOnlineMigrationReceipts(snapshot, source, fail) {
  const known = new Map(source.map((migration) => [migration.name, migration.checksum]));
  const active = new Map();
  for (const receipt of snapshot.receipts) {
    if (receipt.rolled_back === true) continue;
    if (
      receipt.rolled_back !== false ||
      receipt.finished !== true ||
      !Number.isInteger(receipt.steps) ||
      receipt.steps < 0 ||
      typeof receipt.name !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(receipt.checksum ?? '') ||
      active.has(receipt.name)
    )
      fail();
    active.set(receipt.name, receipt);
  }
  for (const receipt of active.values()) {
    const historical = OUTCOME_COHORT_HISTORICAL_COMPATIBILITY.some(
      (variant) => variant.name === receipt.name && variant.checksum === receipt.checksum,
    );
    if (
      historical
        ? !isCompatibleHistoricalReceipt(receipt, known, active, snapshot.historicalCompatibility)
        : known.get(receipt.name) !== receipt.checksum
    )
      fail();
  }
  return active;
}
