import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Prisma } from '../prisma/prisma-client';
import { CHAT_SETTINGS_SQL_COLUMNS } from './chat-settings-projection';

describe('complete native chat settings projection', () => {
  it('maps every generated scalar to its current physical schema column', () => {
    const schema = readFileSync(resolve(__dirname, '../../prisma/schema.prisma'), 'utf8');
    const body = /^model ChatSettings \{([\s\S]*?)^\}/mu.exec(schema)?.[1];
    if (!body) throw new Error('ChatSettings model is missing');
    const scalarKeys = Object.values(Prisma.ChatSettingsScalarFieldEnum);
    const scalarNames = new Set<string>(scalarKeys);
    const columns = Object.fromEntries(
      body.split('\n').flatMap((line) => {
        const key = /^\s*(\w+)\s+/u.exec(line)?.[1];
        return key && scalarNames.has(key)
          ? [[key, /@map\("([^"]+)"\)/u.exec(line)?.[1] ?? key]]
          : [];
      }),
    );
    expect(Object.keys(CHAT_SETTINGS_SQL_COLUMNS).sort()).toEqual([...scalarKeys].sort());
    expect(CHAT_SETTINGS_SQL_COLUMNS).toEqual(columns);
  });

  it('keeps every result alias unique within the PostgreSQL identifier limit', () => {
    // FLAG: PostgreSQL silently truncates identifiers beyond 63 bytes; a long alias
    // would otherwise decode a valid settings row with a missing field.
    const aliases = Object.keys(CHAT_SETTINGS_SQL_COLUMNS).map((key) => `settings_${key}`);
    expect(new Set(aliases).size).toBe(aliases.length);
    for (const alias of aliases) expect(Buffer.byteLength(alias)).toBeLessThanOrEqual(63);
  });
});
