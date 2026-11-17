import { pathToFileURL } from 'node:url';
import { readRoutingIndexSource } from '../../scripts/agent/routing-index-online-target.mjs';
import {
  routingIndexStateSql,
  verifyRoutingIndexState,
} from '../../scripts/agent/routing-index-catalog.mjs';
import { runOutcomeCohortCommand } from './outcome-cohort-online-state.mjs';

export { routingIndexStateSql, verifyRoutingIndexState };

const fail = (code) => {
  throw new Error(`ROUTING_INDEX_${code}`);
};

export async function readRoutingIndexState(
  composeArgs,
  { root = process.cwd(), run = runOutcomeCohortCommand } = {},
) {
  const { validateMultibotComposeArgs } = await import('./multibot-prepare-capacity.mjs');
  validateMultibotComposeArgs(composeArgs);
  const source = readRoutingIndexSource(root);
  try {
    const result = await run(
      'docker',
      [
        'compose',
        ...composeArgs,
        'exec',
        '-T',
        'postgres',
        'psql',
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'maxim',
        '-d',
        'maxim',
        '-Atq',
      ],
      { input: routingIndexStateSql },
    );
    return verifyRoutingIndexState(JSON.parse(result.stdout.trim()), source);
  } catch (error) {
    if (/^ROUTING_INDEX_[A-Z_]+$/u.test(error?.message ?? '')) throw error;
    fail('STATE_UNAVAILABLE');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    if (mode !== 'assert') fail('ARGUMENTS_INVALID');
    const state = await readRoutingIndexState(args);
    if (state.state !== 'already_applied') fail('PREPARATION_INCOMPLETE');
    console.log(JSON.stringify({ stage: 'routing_index_assert', state: state.state }));
  } catch {
    console.error('ROUTING_INDEX_ASSERT_FAILED');
    process.exitCode = 1;
  }
}
