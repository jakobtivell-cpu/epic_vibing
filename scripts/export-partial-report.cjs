#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const inPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(process.cwd(), 'output', 'results.json');
const outPath = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.resolve(process.cwd(), 'output', 'partial_rows_report.tsv');

const raw = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const rows = Array.isArray(raw) ? raw : raw.results || [];
const partial = rows.filter((r) => r.status === 'partial');

function missingFields(d) {
  if (!d) return ['revenue_msek', 'ebit_msek', 'employees', 'ceo'];
  const keys = ['revenue_msek', 'ebit_msek', 'employees', 'ceo'];
  return keys.filter((k) => d[k] == null);
}

function fmtData(d) {
  if (!d) return '(none)';
  return ['revenue_msek', 'ebit_msek', 'employees', 'ceo']
    .map((k) => {
      const v = d[k];
      if (v === null) return `${k}=null`;
      if (typeof v === 'string') return `${k}="${v.replace(/"/g, '""')}"`;
      return `${k}=${v}`;
    })
    .join(' | ');
}

function explanation(notes) {
  if (!notes || !notes.length) return '(no notes)';
  return notes.slice(-10).join(' | ');
}

function escCell(s) {
  const t = String(s ?? '');
  if (/[\t\n\r"]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

const header = [
  'Company',
  'Ticker',
  'Missing fields',
  'Scraped data',
  'Data source',
  'Fiscal year',
  'Confidence',
  'Annual report URL',
  'Explanation',
];

const lines = [header.join('\t')];
for (const r of partial) {
  const d = r.extractedData;
  lines.push(
    [
      escCell(r.company),
      escCell(r.ticker ?? ''),
      escCell(missingFields(d).join(', ')),
      escCell(fmtData(d)),
      escCell(r.dataSource ?? ''),
      escCell(r.fiscalYear),
      escCell(r.confidence),
      escCell(r.annualReportUrl ?? ''),
      escCell(explanation(r.extractionNotes)),
    ].join('\t'),
  );
}

fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');
console.log(`Wrote ${outPath} (${partial.length} partial rows)`);
