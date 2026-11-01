import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canonicalKaravanMarketplaceJson,
  karavanMarketplaceCreateSchema,
  karavanMarketplaceModuleSchema,
  karavanMarketplaceResolveResultSchema,
} from '../src/karavan-marketplace.js';
import {
  marketplaceManagementRequestSchema,
  marketplaceManagementResponseSchema,
} from '../src/karavan-marketplace-management.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/chat-shop-formats-wire.json', import.meta.url), 'utf8'),
);
const responseSchemas: Record<string, { parse(value: unknown): unknown }> = {
  module: karavanMarketplaceModuleSchema,
  resolve: karavanMarketplaceResolveResultSchema,
  management: marketplaceManagementResponseSchema,
};

describe('shared chat shop format wire fixtures', () => {
  it('preserves old create hashes and explicit format identity across both products', () => {
    expect(fixture.schemaVersion).toBe(1);
    for (const scenario of fixture.creates) {
      const parsed = karavanMarketplaceCreateSchema.parse(scenario.input);
      expect(parsed, scenario.id).toEqual(scenario.parsed);
      const canonical = canonicalKaravanMarketplaceJson(parsed);
      expect(canonical, scenario.id).toBe(scenario.canonical);
      expect(createHash('sha256').update(canonical).digest('hex'), scenario.id).toBe(scenario.hash);
    }
    expect(fixture.creates[0].parsed).not.toHaveProperty('format');
    expect(fixture.creates[0].parsed).not.toHaveProperty('administrationStoreId');
    expect(new Set(fixture.creates.map((item: { hash: string }) => item.hash)).size).toBe(3);
  });

  it('preserves exact read, reviewed transition and replay command payloads', () => {
    for (const scenario of fixture.commands) {
      const parsed = marketplaceManagementRequestSchema.parse(scenario.input);
      expect(parsed, scenario.id).toEqual(scenario.parsed);
      const canonical = canonicalKaravanMarketplaceJson(parsed);
      expect(canonical, scenario.id).toBe(scenario.canonical);
      expect(createHash('sha256').update(canonical).digest('hex'), scenario.id).toBe(scenario.hash);
    }
  });

  it('retains fixed direct targets, blocked state and transition epochs in provider responses', () => {
    for (const scenario of fixture.responses) {
      expect(responseSchemas[scenario.schema].parse(scenario.value), scenario.id).toEqual(
        scenario.value,
      );
    }
  });
});
