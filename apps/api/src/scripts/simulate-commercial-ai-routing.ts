import { constants } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  commercialAiRoutingScenarioSchema,
  simulateCommercialAiRouting,
} from './commercial-ai-routing-simulation';

export async function runCommercialAiRoutingSimulation(argv: string[]) {
  if (argv.length !== 4 || argv[0] !== '--input' || argv[2] !== '--output')
    throw new Error('Usage: --input /private/scenario.json --output /private/report.json');
  let value: unknown;
  try {
    const file = await open(resolve(argv[1]!), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const limit = 64 * 1024 * 1024;
      const info = await file.stat();
      if (!info.isFile() || info.size > limit) throw new Error();
      const chunks: Buffer[] = [];
      let total = 0;
      while (total <= limit) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, limit + 1 - total));
        const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        chunks.push(chunk.subarray(0, bytesRead));
        total += bytesRead;
      }
      if (total > limit) throw new Error();
      value = JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
    } finally {
      await file.close();
    }
  } catch {
    throw new Error('Commercial AI routing scenario file is invalid or unavailable');
  }
  const parsed = commercialAiRoutingScenarioSchema.safeParse(value);
  if (!parsed.success) throw new Error('Commercial AI routing scenario schema is invalid');
  const report = simulateCommercialAiRouting(parsed.data);
  try {
    await writeFile(resolve(argv[3]!), `${JSON.stringify(report, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch {
    throw new Error('Commercial AI routing report output could not be written');
  }
  process.stdout.write('Offline routing simulation complete; runtime changes applied: false\n');
  return report;
}

if (require.main === module)
  runCommercialAiRoutingSimulation(process.argv.slice(2)).catch(() => {
    process.stderr.write(
      'Commercial AI routing simulation failed; verify private scenario and arguments.\n',
    );
    process.exitCode = 1;
  });
