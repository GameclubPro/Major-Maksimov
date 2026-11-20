import type { Pool } from 'pg';

export function observePoolErrors(
  pool: Pool,
  write = (line: string) => process.stderr.write(line),
) {
  let lastLoggedAt = -Infinity;
  // FLAG: pg-pool already evicts a disconnected idle client. Only log the bounded event.
  pool.on('error', () => {
    const now = Date.now();
    if (now - lastLoggedAt < 30_000) return;
    lastLoggedAt = now;
    write(JSON.stringify({ service: 'eraser', code: 'idle_database_connection_lost' }) + '\n');
  });
}
