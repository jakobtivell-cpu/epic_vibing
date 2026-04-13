#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const inPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(process.cwd(), 'output', 'results.json');

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

const buckets = {
  timeout: 0,
  failed: 0,
  no_pdf: 0,
  discovery_budget: 0,
  fallback_budget: 0,
};

for (const r of rows) {
  const notes = Array.isArray(r.extractionNotes) ? r.extractionNotes.join(' | ') : '';
  if (r.status === 'timeout') buckets.timeout++;
  if (r.status === 'failed') buckets.failed++;
  if (/no (income statement signals|extracted data)|quality gate rejected/i.test(notes)) buckets.no_pdf++;
  if (/Stage budget exhausted for .*discover/i.test(notes)) buckets.discovery_budget++;
  if (/Stage budget exhausted for .*ir-html|allabolag/i.test(notes)) buckets.fallback_budget++;
}

console.log(JSON.stringify({ source: inPath, totalRows: rows.length, buckets }, null, 2));
