#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { buildLedger } = require('./lib/null-reasons-infer.cjs');

const args = process.argv.slice(2).filter((a) => a !== '--write-ledger');
const WRITE_LEDGER = process.argv.includes('--write-ledger');

const RESULTS_PATH = args[0]
  ? path.resolve(args[0])
  : path.resolve(process.cwd(), 'output', 'results.json');

function loadRows(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.results)) return parsed.results;
  throw new Error(`Unsupported results format in ${filePath}`);
}

function hasNonAnnualSignal(text) {
  return /\b(corporate governance|governance report|policy|presentation|factbook|agm|general meeting|remuneration report)\b/i.test(
    text,
  );
}

function hasAnnualSignal(text) {
  return /\b(annual report|årsredovisning|annual and sustainability report|integrated report)\b/i.test(
    text,
  );
}

function countNullHeadlineFields(rows) {
  const fields = ['revenue_msek', 'ebit_msek', 'employees', 'ceo'];
  const out = {};
  for (const f of fields) {
    const nulls = rows.filter((r) => !r.extractedData || r.extractedData[f] === null).length;
    out[f] = {
      nulls,
      nullRate: Number(((nulls / Math.max(rows.length, 1)) * 100).toFixed(1)),
    };
  }
  return out;
}

function collectDiscardReasons(rows) {
  const buckets = {
    ebit_gt_revenue: 0,
    revenue_implausible: 0,
    ebit_implausible: 0,
    employee_low: 0,
    employee_high: 0,
    employee_year_misread: 0,
    wrong_report_class: 0,
  };

  for (const row of rows) {
    const notes = row.extractionNotes || [];
    const combined = notes.join(' | ');
    if (/ebit .*exceeds revenue|discarding ebit/i.test(combined)) buckets.ebit_gt_revenue += 1;
    if (/revenue implausibly high|revenue .*implausible/i.test(combined)) buckets.revenue_implausible += 1;
    if (/ebit implausibly large/i.test(combined)) buckets.ebit_implausible += 1;
    if (/employee count too low|suspect_low/i.test(combined)) buckets.employee_low += 1;
    if (/employee count implausibly high/i.test(combined)) buckets.employee_high += 1;
    if (/fiscal-year column misread/i.test(combined)) buckets.employee_year_misread += 1;

    const candidateText = `${row.annualReportUrl ?? ''} ${combined}`;
    if (hasNonAnnualSignal(candidateText) && !hasAnnualSignal(candidateText)) {
      buckets.wrong_report_class += 1;
    }
  }

  return buckets;
}

function wrongReportClassCandidates(rows) {
  const flagged = [];
  for (const row of rows) {
    const notes = row.extractionNotes || [];
    const haystack = `${row.annualReportUrl ?? ''} ${notes.join(' ')}`;
    if (hasNonAnnualSignal(haystack) && !hasAnnualSignal(haystack)) {
      flagged.push({
        company: row.company,
        ticker: row.ticker ?? null,
        status: row.status,
        annualReportUrl: row.annualReportUrl,
      });
    }
  }
  return flagged;
}

function main() {
  if (!fs.existsSync(RESULTS_PATH)) {
    throw new Error(`Results file not found: ${RESULTS_PATH}`);
  }

  const rows = loadRows(RESULTS_PATH);
  const summary = {
    source: RESULTS_PATH,
    totalRows: rows.length,
    byStatus: rows.reduce((acc, r) => {
      const k = r.status || 'unknown';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
    nullHeadlineFields: countNullHeadlineFields(rows),
    discardReasons: collectDiscardReasons(rows),
    wrongReportClassCandidates: wrongReportClassCandidates(rows),
    nullFieldTallies: buildLedger(rows).tallies,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (WRITE_LEDGER) {
    const outPath = path.join(path.dirname(RESULTS_PATH), 'results_null_ledger.json');
    const ledger = buildLedger(rows);
    ledger.source = RESULTS_PATH;
    fs.writeFileSync(outPath, JSON.stringify(ledger, null, 2), 'utf-8');
    console.error(`Wrote ${outPath}`);
  }
}

main();
