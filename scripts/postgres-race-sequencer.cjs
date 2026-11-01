const { posix } = require('node:path');
const Sequencer = require('@jest/test-sequencer').default;

const rollupPath = 'src/admin/publication-occurrence-rollup-noop-postgres.spec.ts';
const diagnosticPath = 'src/scripts/diagnose-vk-parsing-postgres.spec.ts';

function relativePath(test) {
  return posix.relative(
    test.context.config.rootDir.replaceAll('\\', '/'),
    test.path.replaceAll('\\', '/'),
  );
}

module.exports = class PostgresRaceSequencer extends Sequencer {
  shard(tests, options) {
    const selected = super.shard(tests, options);
    if (options.shardCount !== 8) return selected;

    const rollups = tests.filter((test) => relativePath(test) === rollupPath);
    const diagnostics = tests.filter((test) => relativePath(test) === diagnosticPath);
    if (rollups.length > 1 || diagnostics.length > 1)
      throw new Error('Native race rebalance requires unique exception suite paths');
    const [rollup] = rollups;
    const [diagnostic] = diagnostics;
    if (!rollup || !diagnostic) return selected;

    // FLAG: Three history-heavy suites exhausted one native job's ten-minute budget.
    // Swap these two whole suites after default sharding; retain every original Test,
    // lane capacity, SQL fixture, serial worker and inherited sorting/cache behavior.
    return selected.map((test) =>
      test === rollup ? diagnostic : test === diagnostic ? rollup : test,
    );
  }
};
