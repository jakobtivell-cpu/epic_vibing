#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const inPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(process.cwd(), 'output', 'results.json');
const outPath = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.resolve(process.cwd(), 'output', 'manual_review_queue.csv');

if (!fs.existsSync(inPath)) {
  console.error(`Input not found: ${inPath}`);
  process.exit(1);
}

const parsed = JSON.parse(fs.readFileSync(inPath, 'utf-8'));
const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.results) ? parsed.results : null;
if (!rows) {
  console.error('Expected results array or { results: [...] }');
  process.exit(1);
}

const queue = rows.filter((r) => {
  const d = r?.extractedData;
  if (!d) return true;
  return (
    d.revenue_msek == null ||
    d.ebit_msek == null ||
    d.employees == null ||
    d.ceo == null
  );
});

const esc = (v) => {
  const s = v == null ? '' : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

const header = [
  'company',
  'ticker',
  'status',
  'annualReportUrl',
  'irPage',
  'revenue_msek',
  'ebit_msek',
  'employees',
  'ceo',
  'missingFields',
  'suggestedOverrideJson',
  'latestNote',
];

const lines = [header.join(',')];
for (const r of queue) {
  const d = r.extractedData || {};
  const missing = [
    d.revenue_msek == null ? 'revenue_msek' : null,
    d.ebit_msek == null ? 'ebit_msek' : null,
    d.employees == null ? 'employees' : null,
    d.ceo == null ? 'ceo' : null,
  ].filter(Boolean);
  const suggested = JSON.stringify({
    source: 'manual_review',
    reviewedAt: new Date().toISOString().slice(0, 10),
    ...(d.revenue_msek == null ? { revenue_msek: null } : {}),
    ...(d.ebit_msek == null ? { ebit_msek: null } : {}),
    ...(d.employees == null ? { employees: null } : {}),
    ...(d.ceo == null ? { ceo: null } : {}),
  });
  const latestNote =
    Array.isArray(r.extractionNotes) && r.extractionNotes.length > 0
      ? r.extractionNotes[r.extractionNotes.length - 1]
      : '';
  const row = [
    r.company,
    r.ticker ?? '',
    r.status ?? '',
    r.annualReportUrl ?? '',
    r.irPage ?? '',
    d.revenue_msek ?? '',
    d.ebit_msek ?? '',
    d.employees ?? '',
    d.ceo ?? '',
    missing.join('|'),
    suggested,
    latestNote,
  ].map(esc);
  lines.push(row.join(','));
}

fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');
console.log(`Wrote ${outPath} (${queue.length} rows)`);
