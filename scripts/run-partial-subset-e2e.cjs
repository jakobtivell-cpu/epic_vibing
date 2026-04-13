/**
 * Sets RUN_PARTIAL_SUBSET_SCRAPE_E2E=1 and runs the partial-subset scrape E2E.
 */
process.env.RUN_PARTIAL_SUBSET_SCRAPE_E2E = '1';

const { spawnSync } = require('node:child_process');

const result = spawnSync(
  'npx',
  ['jest', 'tests/partial-subset-scrape-e2e.test.ts', '--runInBand', '--testTimeout=86400000'],
  { stdio: 'inherit', shell: true, env: process.env },
);

process.exit(result.status == null ? 1 : result.status);
