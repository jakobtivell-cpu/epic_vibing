#!/usr/bin/env node
'use strict';

/**
 * Targeted re-scrape: only re-runs the non-complete tickers from the last
 * overnight batch and merges the results back into output/results.json.
 *
 * Designed to complete within 2 hours for ~54 companies.
 *
 * Usage:
 *   node scripts/run-targeted-rescrape.cjs
 *   node scripts/run-targeted-rescrape.cjs --concurrency 5
 *   node scripts/run-targeted-rescrape.cjs --timeout-per-company 240000
 *
 * After completion, results are in output/results.json and output/run_summary.json.
 * Follow up with quality analysis:
 *   node scripts/analyze-results-quality.cjs
 */

const { spawnSync } = require('node:child_process');

function printHelp() {
  console.log(
    [
      'Usage: node scripts/run-targeted-rescrape.cjs [options]',
      '',
      'Options:',
      '  --concurrency <n>            Parallel company subprocesses (default: 4)',
      '  --timeout-per-company <ms>   Wall-clock cap per company in ms (default: 200000 = 3.3 min)',
      '  --help                       Show this help and exit',
      '',
      'The scrape merges fresh results into output/results.json and writes output/run_summary.json.',
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

process.env.RUN_TARGETED_RESCRAPE_E2E = '1';

if (parsed.concurrency != null) {
  process.env.TARGETED_RESCRAPE_CONCURRENCY = String(parsed.concurrency);
}
if (parsed.timeoutPerCompany != null) {
  process.env.TARGETED_RESCRAPE_TIMEOUT = String(parsed.timeoutPerCompany);
}

const concurrency = parsed.concurrency ?? 4;
const timeout = parsed.timeoutPerCompany ?? 200000;
const n = 54; // current non-complete subset size
const worstCaseMin = Math.ceil((n * timeout) / concurrency / 60000);

console.log('=== Targeted re-scrape (non-complete subset) ===');
console.log(`Subset size:         ~${n} companies`);
console.log(`Concurrency:         ${concurrency}`);
console.log(`Timeout per company: ${timeout}ms (${(timeout / 1000).toFixed(0)}s)`);
console.log(`Worst-case wall clock: ~${worstCaseMin} min`);
console.log(`Started at:          ${new Date().toISOString()}`);
console.log('');

// Jest timeout: 2.5 hours (2h budget + 0.5h headroom)
const jestTimeoutMs = 2.5 * 60 * 60 * 1000;

const result = spawnSync(
  'npx',
  [
    'jest',
    'tests/targeted-rescrape-e2e.test.ts',
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
