#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

function run(cmd, args) {
  const r = cp.spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  return r.status ?? 1;
}

const cwd = process.cwd();
const candidate = path.resolve(cwd, 'output', 'results.json');
const baseline =
  process.env.CANARY_BASELINE_PATH &&
  fs.existsSync(path.resolve(process.env.CANARY_BASELINE_PATH))
    ? path.resolve(process.env.CANARY_BASELINE_PATH)
    : path.resolve(cwd, 'output', 'results.baseline.json');

if (fs.existsSync(baseline) && fs.existsSync(candidate)) {
  const status = run('node', ['scripts/check-canary-diff.cjs', baseline, candidate]);
  if (status !== 0) process.exit(status);
} else {
  console.warn(`gate:promotion: skipping canary diff (baseline missing at ${baseline})`);
}

for (const args of [
  ['run', 'analyze:quality', '--', candidate],
  ['run', 'analyze:null-ledger', '--', candidate],
  [
    'run',
    'test',
    '--',
    '--runTestsByPath',
    'tests/validator-reporting-model.test.ts',
    'tests/bank-extraction.test.ts',
    'tests/income-section-and-revenue-guard.test.ts',
    'tests/partial-subset-scrape-e2e.test.ts',
  ],
]) {
  const status = run('npm', args);
  if (status !== 0) process.exit(status);
}
