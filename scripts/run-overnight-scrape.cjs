#!/usr/bin/env node
'use strict';

/**
 * Launches the overnight full-scrape E2E test with sensible defaults.
 * Designed to complete within ~8 hours for all ~136 companies.
 *
 * Usage:
 *   node scripts/run-overnight-scrape.cjs
 *   node scripts/run-overnight-scrape.cjs --concurrency 5
 *   node scripts/run-overnight-scrape.cjs --timeout-per-company 300000
 *   node scripts/run-overnight-scrape.cjs --concurrency 4 --timeout-per-company 240000
 *
 * After completion, results are in output/results.json and output/run_summary.json.
 * Follow up with quality analysis:
 *   node scripts/analyze-results-quality.cjs
 */

const { spawnSync } = require('node:child_process');

function printHelp() {
  console.log(
    [
      'Usage: node scripts/run-overnight-scrape.cjs [options]',
      '',
      'Options:',
      '  --concurrency <n>            Parallel company subprocesses (default: 3)',
      '  --timeout-per-company <ms>   Wall-clock cap per company in ms (default: 210000 = 3.5 min)',
      '  --help                       Show this help and exit',
      '',
      'The scrape writes output/results.json and output/run_summary.json.',
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
  let timeoutPerCompany;

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
      concurrency = parsePositiveInt(arg.slice('--concurrency='.length), '--concurrency');
      continue;
    }
    if (arg === '--timeout-per-company') {
      const value = argv[i + 1];
      if (!value) throw new Error('--timeout-per-company requires a value');
      timeoutPerCompany = parsePositiveInt(value, '--timeout-per-company');
      i++;
      continue;
    }
    if (arg.startsWith('--timeout-per-company=')) {
      timeoutPerCompany = parsePositiveInt(arg.slice('--timeout-per-company='.length), '--timeout-per-company');
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return { concurrency, timeoutPerCompany };
}

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  console.error('Use --help to see available options.');
  process.exit(2);
}

process.env.RUN_OVERNIGHT_SCRAPE_E2E = '1';

if (parsed.concurrency != null) {
  process.env.OVERNIGHT_CONCURRENCY = String(parsed.concurrency);
}
if (parsed.timeoutPerCompany != null) {
  process.env.OVERNIGHT_TIMEOUT_PER_COMPANY = String(parsed.timeoutPerCompany);
}

const concurrency = parsed.concurrency ?? 3;
const timeout = parsed.timeoutPerCompany ?? 210000;

console.log('=== Overnight full scrape ===');
console.log(`Concurrency:         ${concurrency}`);
console.log(`Timeout per company: ${timeout}ms (${(timeout / 1000).toFixed(0)}s)`);
console.log(`Started at:          ${new Date().toISOString()}`);
console.log('');

// Jest timeout: 9 hours (8h budget + 1h headroom for startup/teardown)
const jestTimeoutMs = 9 * 60 * 60 * 1000;

const result = spawnSync(
  'npx',
  [
    'jest',
    'tests/overnight-full-scrape.test.ts',
    '--runInBand',
    `--testTimeout=${jestTimeoutMs}`,
  ],
  {
    stdio: 'inherit',
    shell: true,
    env: process.env,
  },
);

console.log(`\nFinished at: ${new Date().toISOString()}`);
process.exit(result.status == null ? 1 : result.status);
