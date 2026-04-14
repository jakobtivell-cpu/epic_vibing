#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

function run(cmd, args) {
  const status = cp.spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  }).status;
  return status == null ? 1 : status;
}

function readResults(resultsPath) {
  if (!fs.existsSync(resultsPath)) {
    throw new Error(`results.json not found at ${resultsPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
  return Array.isArray(raw) ? raw : raw.results ?? [];
}

function pct(part, total) {
  if (!total) return 0;
  return (part / total) * 100;
}

function statusCounts(rows) {
  const counts = { complete: 0, partial: 0, failed: 0, timeout: 0 };
  for (const r of rows) {
    if (r && typeof r.status === 'string' && Object.hasOwn(counts, r.status)) {
      counts[r.status]++;
    }
  }
  return counts;
}

const root = process.cwd();
const resultsPath = path.resolve(root, 'output', 'results.json');

const minCompletePct = Number(process.env.MIN_COMPLETE_PCT ?? '0');
const maxFailedPct = Number(process.env.MAX_FAILED_PCT ?? '100');
const maxTimeoutPct = Number(process.env.MAX_TIMEOUT_PCT ?? '100');

if (!Number.isFinite(minCompletePct) || !Number.isFinite(maxFailedPct) || !Number.isFinite(maxTimeoutPct)) {
  console.error('Threshold env vars must be numeric: MIN_COMPLETE_PCT, MAX_FAILED_PCT, MAX_TIMEOUT_PCT');
  process.exit(2);
}

console.log('== Full all-company E2E scrape ==');
let status = run('node', ['scripts/run-all-ticker-e2e.cjs']);
if (status !== 0) process.exit(status);

console.log('== Analyze quality ==');
status = run('node', ['scripts/analyze-results-quality.cjs', resultsPath]);
if (status !== 0) process.exit(status);

console.log('== Write null-reason ledger ==');
status = run('node', ['scripts/analyze-results-quality.cjs', '--write-ledger', resultsPath]);
if (status !== 0) process.exit(status);

const rows = readResults(resultsPath);
const counts = statusCounts(rows);
const total = rows.length;
const completePct = pct(counts.complete, total);
const failedPct = pct(counts.failed, total);
const timeoutPct = pct(counts.timeout, total);

console.log('\n== Full-run summary ==');
console.log(
  [
    `total=${total}`,
    `complete=${counts.complete} (${completePct.toFixed(1)}%)`,
    `partial=${counts.partial}`,
    `failed=${counts.failed} (${failedPct.toFixed(1)}%)`,
    `timeout=${counts.timeout} (${timeoutPct.toFixed(1)}%)`,
  ].join(' | '),
);

const thresholdFailures = [];
if (completePct < minCompletePct) {
  thresholdFailures.push(`complete ${completePct.toFixed(1)}% < MIN_COMPLETE_PCT ${minCompletePct}%`);
}
if (failedPct > maxFailedPct) {
  thresholdFailures.push(`failed ${failedPct.toFixed(1)}% > MAX_FAILED_PCT ${maxFailedPct}%`);
}
if (timeoutPct > maxTimeoutPct) {
  thresholdFailures.push(`timeout ${timeoutPct.toFixed(1)}% > MAX_TIMEOUT_PCT ${maxTimeoutPct}%`);
}

if (thresholdFailures.length > 0) {
  console.error('\nThreshold check failed:');
  for (const f of thresholdFailures) console.error(`- ${f}`);
  process.exit(1);
}

console.log('\nThreshold check passed.');
