/**
 * Sets RUN_ALL_TICKERS_SCRAPE_E2E=1 and runs the full-ticker scrape E2E in band.
 * Each company subprocess is capped at 3 minutes (see all-ticker-companies.ts).
 */
process.env.RUN_ALL_TICKERS_SCRAPE_E2E = '1';

const { spawnSync } = require('node:child_process');

const result = spawnSync(
  'npx',
  ['jest', 'tests/all-ticker-scrape-e2e.test.ts', '--runInBand', '--testTimeout=86400000'],
  { stdio: 'inherit', shell: true, env: process.env },
);

process.exit(result.status == null ? 1 : result.status);
