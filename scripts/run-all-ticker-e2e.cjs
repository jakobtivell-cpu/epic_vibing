/**
 * Sets RUN_ALL_TICKERS_SCRAPE_E2E=1 and runs the full-ticker scrape E2E in band.
 * Each company subprocess is capped at 3 minutes (see all-ticker-companies.ts).
 *
 * Usage:
 *   node scripts/run-all-ticker-e2e.cjs
 *   node scripts/run-all-ticker-e2e.cjs --concurrency 4
 */
process.env.RUN_ALL_TICKERS_SCRAPE_E2E = '1';

const { spawnSync } = require('node:child_process');

function printHelp() {
  console.log(
    [
      'Usage: node scripts/run-all-ticker-e2e.cjs [options]',
      '',
      'Options:',
      '  --concurrency <n>  Number of concurrent company subprocesses (default: 1)',
      '  --help             Show this help and exit',
    ].join('\n'),
  );
}

function parsePositiveInt(value, flagName) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  let concurrency;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--concurrency') {
      const value = argv[i + 1];
      if (!value) throw new Error('--concurrency requires a value');
      concurrency = parsePositiveInt(value, '--concurrency');
      i++;
      continue;
    }
    if (arg.startsWith('--concurrency=')) {
      const value = arg.slice('--concurrency='.length);
      concurrency = parsePositiveInt(value, '--concurrency');
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return { concurrency };
}

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  console.error('Use --help to see available options.');
  process.exit(2);
}

if (parsed.concurrency != null) {
  process.env.RUN_ALL_TICKERS_CONCURRENCY = String(parsed.concurrency);
}

const result = spawnSync(
  'npx',
  ['jest', 'tests/all-ticker-scrape-e2e.test.ts', '--runInBand', '--testTimeout=86400000'],
  { stdio: 'inherit', shell: true, env: process.env },
);

process.exit(result.status == null ? 1 : result.status);
