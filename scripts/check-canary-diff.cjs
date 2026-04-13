#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function usageAndExit() {
  console.error('Usage: node scripts/check-canary-diff.cjs <baseline.json> <candidate.json>');
  process.exit(2);
}

const baselinePath = process.argv[2] ? path.resolve(process.argv[2]) : null;
const candidatePath = process.argv[3] ? path.resolve(process.argv[3]) : null;
if (!baselinePath || !candidatePath) usageAndExit();

function readRows(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : parsed.results || [];
}

function rowKey(row) {
  return (row.ticker || row.company || '').toLowerCase();
}

function headlineFields(row) {
  const d = row.extractedData || {};
  return [d.revenue_msek, d.ebit_msek, d.employees, d.ceo];
}

function isWorseStatus(before, after) {
  if (before !== 'complete') return false;
  return after === 'partial' || after === 'failed' || after === 'timeout';
}

function main() {
  const baselineRows = readRows(baselinePath);
  const candidateRows = readRows(candidatePath);
  const byKey = new Map(candidateRows.map((r) => [rowKey(r), r]));

  const regressions = [];
  for (const before of baselineRows) {
    if (before.status !== 'complete') continue;
    const after = byKey.get(rowKey(before));
    if (!after) continue;

    if (isWorseStatus(before.status, after.status)) {
      regressions.push({
        company: before.company,
        ticker: before.ticker ?? null,
        reason: `status ${before.status} -> ${after.status}`,
      });
      continue;
    }

    const b = headlineFields(before);
    const a = headlineFields(after);
    const labels = ['revenue_msek', 'ebit_msek', 'employees', 'ceo'];
    for (let i = 0; i < labels.length; i++) {
      if (b[i] !== null && a[i] === null) {
        regressions.push({
          company: before.company,
          ticker: before.ticker ?? null,
          reason: `${labels[i]} dropped from non-null to null`,
        });
      }
    }
  }

  if (regressions.length > 0) {
    console.error(JSON.stringify({ ok: false, regressions }, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify({ ok: true, checked: baselineRows.length }, null, 2));
}

main();
