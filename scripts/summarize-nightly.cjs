#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { buildLedger } = require('./lib/null-reasons-infer.cjs');

const RESULTS_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(process.cwd(), 'output', 'results.json');

const SUMMARY_PATH = path.resolve(path.dirname(RESULTS_PATH), 'run_summary.json');

// ── helpers ─────────────────────────────────────────────────────────────────

function loadRows(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return { rows: parsed, generatedAt: null };
  if (Array.isArray(parsed.results)) {
    return { rows: parsed.results, generatedAt: parsed.generatedAt ?? null };
  }
  throw new Error(`Unsupported results format in ${filePath}`);
}

function loadRunSummary() {
  if (!fs.existsSync(SUMMARY_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(SUMMARY_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function pct(n, total) {
  if (total === 0) return '  0.0%';
  return `${((n / total) * 100).toFixed(1).padStart(5)}%`;
}

function bar(n, total, width = 30) {
  if (total === 0) return ' '.repeat(width);
  const filled = Math.round((n / total) * width);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
}

function padR(s, w) {
  return String(s).padEnd(w);
}

function padL(s, w) {
  return String(s).padStart(w);
}

function fmtDuration(ms) {
  if (!ms) return 'N/A';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ── classification (mirrors writer.ts) ──────────────────────────────────────

function classifyFailureClass(r) {
  if (r.status === 'timeout') return 'timeout';
  if (r.status === 'complete') return 'complete';
  if (r.dataSource === 'allabolag') return 'allabolag_partial';
  if (r.dataSource === 'ir-html') return 'partial_pdf';
  if (r.status === 'partial') return 'partial_pdf';
  return 'failed_other';
}

function countFields(r) {
  let n = 0;
  const d = r.extractedData;
  if (d) {
    if (d.revenue_msek !== null) n++;
    if (d.ebit_msek !== null) n++;
    if (d.employees !== null) n++;
    if (d.ceo !== null) n++;
  }
  if (r.fiscalYear !== null) n++;
  return n;
}

// ── grade ───────────────────────────────────────────────────────────────────

function healthGrade(completeRate, partialRate, timeoutRate) {
  const score = completeRate * 1.0 + partialRate * 0.5;
  if (score >= 0.85 && timeoutRate < 0.05) return 'A';
  if (score >= 0.75 && timeoutRate < 0.10) return 'B';
  if (score >= 0.60 && timeoutRate < 0.20) return 'C';
  if (score >= 0.40) return 'D';
  return 'F';
}

// ── main ────────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(RESULTS_PATH)) {
    console.error(`Results file not found: ${RESULTS_PATH}`);
    process.exit(1);
  }

  const { rows, generatedAt } = loadRows(RESULTS_PATH);
  const runSummary = loadRunSummary();
  const total = rows.length;

  if (total === 0) {
    console.log('No results to summarize.');
    return;
  }

  const counts = { complete: 0, partial: 0, failed: 0, timeout: 0 };
  for (const r of rows) {
    if (r.status in counts) counts[r.status]++;
  }

  const dblBar = '\u2550'.repeat(62);
  const sglBar = '\u2500'.repeat(62);
  const out = [];

  // ── header ──────────────────────────────────────────────────────────────

  out.push('');
  out.push(dblBar);
  out.push('  NIGHTLY SCRAPE SUMMARY');
  out.push(sglBar);

  const ts = runSummary?.timestamp ?? generatedAt ?? 'unknown';
  const dur = runSummary?.durationMs
    ? fmtDuration(runSummary.durationMs)
    : runSummary?.durationHuman ?? 'N/A';
  const conc = runSummary?.concurrency ?? 'N/A';

  out.push(`  Timestamp:   ${ts}`);
  out.push(`  Duration:    ${dur}`);
  out.push(`  Concurrency: ${conc}`);
  out.push(`  Companies:   ${total}`);
  out.push(`  Source:       ${path.relative(process.cwd(), RESULTS_PATH)}`);
  out.push('');

  // ── status breakdown ────────────────────────────────────────────────────

  const completeRate = counts.complete / total;
  const partialRate = counts.partial / total;
  const timeoutRate = counts.timeout / total;
  const grade = healthGrade(completeRate, partialRate, timeoutRate);

  out.push(`  Health grade: ${grade}`);
  out.push('');
  out.push('  STATUS BREAKDOWN');
  out.push(sglBar);

  const statusColors = [
    ['Complete', counts.complete],
    ['Partial', counts.partial],
    ['Failed', counts.failed],
    ['Timeout', counts.timeout],
  ];

  for (const [label, n] of statusColors) {
    out.push(
      `  ${padR(label, 10)} ${padL(n, 4)}  ${pct(n, total)}  ${bar(n, total)}`,
    );
  }
  out.push('');

  // ── headline null rates ────────────────────────────────────────────────

  out.push('  HEADLINE FIELD COVERAGE');
  out.push(sglBar);

  const fields = ['revenue_msek', 'ebit_msek', 'employees', 'ceo'];
  const fieldLabels = { revenue_msek: 'Revenue', ebit_msek: 'EBIT', employees: 'Employees', ceo: 'CEO' };

  for (const f of fields) {
    const populated = rows.filter(
      (r) => r.extractedData && r.extractedData[f] !== null,
    ).length;
    const nulls = total - populated;
    const fillRate = populated / total;
    out.push(
      `  ${padR(fieldLabels[f], 12)} ${padL(populated, 4)} ok  ${padL(nulls, 4)} null  ${pct(populated, total)}  ${bar(populated, total)}`,
    );
  }

  const fyPopulated = rows.filter((r) => r.fiscalYear !== null).length;
  out.push(
    `  ${padR('Fiscal Year', 12)} ${padL(fyPopulated, 4)} ok  ${padL(total - fyPopulated, 4)} null  ${pct(fyPopulated, total)}  ${bar(fyPopulated, total)}`,
  );
  out.push('');

  // ── data source breakdown ──────────────────────────────────────────────

  out.push('  DATA SOURCE');
  out.push(sglBar);

  const sourceBuckets = {};
  for (const r of rows) {
    const src = r.dataSource ?? '(none)';
    sourceBuckets[src] = (sourceBuckets[src] || 0) + 1;
  }

  const sortedSources = Object.entries(sourceBuckets).sort((a, b) => b[1] - a[1]);
  for (const [src, n] of sortedSources) {
    out.push(`  ${padR(src, 20)} ${padL(n, 4)}  ${pct(n, total)}`);
  }
  out.push('');

  // ── fallback step breakdown ────────────────────────────────────────────

  out.push('  FALLBACK STEP REACHED');
  out.push(sglBar);

  const stepBuckets = {};
  for (const r of rows) {
    const step = r.fallbackStepReached ?? '(none)';
    stepBuckets[step] = (stepBuckets[step] || 0) + 1;
  }

  const sortedSteps = Object.entries(stepBuckets).sort((a, b) => b[1] - a[1]);
  for (const [step, n] of sortedSteps) {
    out.push(`  ${padR(step, 20)} ${padL(n, 4)}  ${pct(n, total)}`);
  }
  out.push('');

  // ── failure class breakdown ────────────────────────────────────────────

  const failureClasses = {};
  for (const r of rows) {
    const cls = classifyFailureClass(r);
    failureClasses[cls] = (failureClasses[cls] || 0) + 1;
  }

  const nonComplete = Object.entries(failureClasses).filter(
    ([k]) => k !== 'complete',
  );
  if (nonComplete.length > 0) {
    out.push('  FAILURE CLASSES');
    out.push(sglBar);
    nonComplete.sort((a, b) => b[1] - a[1]);
    for (const [cls, n] of nonComplete) {
      out.push(`  ${padR(cls, 26)} ${padL(n, 4)}  ${pct(n, total)}`);
    }
    out.push('');
  }

  // ── null reason tallies ────────────────────────────────────────────────

  const ledger = buildLedger(rows);
  const tallies = ledger.tallies;
  const hasNullReasons = Object.values(tallies).some(
    (t) => Object.keys(t).length > 0,
  );

  if (hasNullReasons) {
    out.push('  NULL FIELD REASONS (top per field)');
    out.push(sglBar);

    for (const f of fields) {
      const t = tallies[f];
      if (!t || Object.keys(t).length === 0) continue;
      const sorted = Object.entries(t).sort((a, b) => b[1] - a[1]);
      out.push(`  ${fieldLabels[f]}:`);
      for (const [reason, n] of sorted.slice(0, 5)) {
        out.push(`    ${padR(reason, 42)} ${padL(n, 3)}`);
      }
    }
    out.push('');
  }

  // ── problem companies ──────────────────────────────────────────────────

  const failedRows = rows.filter((r) => r.status === 'failed');
  const timeoutRows = rows.filter((r) => r.status === 'timeout');

  if (failedRows.length > 0) {
    out.push(`  FAILED COMPANIES (${failedRows.length})`);
    out.push(sglBar);
    for (const r of failedRows.slice(0, 20)) {
      const lastNote = (r.extractionNotes || []).slice(-1)[0] || '';
      const truncNote = lastNote.length > 50 ? lastNote.slice(0, 50) + '\u2026' : lastNote;
      out.push(`  ${padR(r.company, 22)} ${truncNote}`);
    }
    if (failedRows.length > 20) {
      out.push(`  ... and ${failedRows.length - 20} more`);
    }
    out.push('');
  }

  if (timeoutRows.length > 0) {
    out.push(`  TIMED-OUT COMPANIES (${timeoutRows.length})`);
    out.push(sglBar);
    for (const r of timeoutRows.slice(0, 15)) {
      const step = r.fallbackStepReached ?? 'none';
      const fields = countFields(r);
      out.push(`  ${padR(r.company, 22)} step=${padR(step, 12)} ${fields}/5 fields`);
    }
    if (timeoutRows.length > 15) {
      out.push(`  ... and ${timeoutRows.length - 15} more`);
    }
    out.push('');
  }

  // ── partial companies with most missing fields ─────────────────────────

  const partialRows = rows
    .filter((r) => r.status === 'partial')
    .map((r) => ({ ...r, _fields: countFields(r) }))
    .sort((a, b) => a._fields - b._fields);

  if (partialRows.length > 0) {
    const worstPartials = partialRows.slice(0, 10);
    out.push(`  WORST PARTIAL COMPANIES (${partialRows.length} total, showing up to 10)`);
    out.push(sglBar);
    for (const r of worstPartials) {
      const missing = [];
      const d = r.extractedData;
      if (!d || d.revenue_msek === null) missing.push('revenue');
      if (!d || d.ebit_msek === null) missing.push('ebit');
      if (!d || d.employees === null) missing.push('employees');
      if (!d || d.ceo === null) missing.push('ceo');
      if (r.fiscalYear === null) missing.push('fy');
      out.push(
        `  ${padR(r.company, 22)} ${r._fields}/5  missing: ${missing.join(', ')}`,
      );
    }
    out.push('');
  }

  // ── confidence distribution ────────────────────────────────────────────

  const confBuckets = { high: 0, mid: 0, low: 0, none: 0 };
  for (const r of rows) {
    const c = r.confidence;
    if (c === null || c === undefined) confBuckets.none++;
    else if (c >= 80) confBuckets.high++;
    else if (c >= 50) confBuckets.mid++;
    else confBuckets.low++;
  }

  out.push('  CONFIDENCE DISTRIBUTION');
  out.push(sglBar);
  out.push(`  High (\u226580%)   ${padL(confBuckets.high, 4)}  ${pct(confBuckets.high, total)}`);
  out.push(`  Mid  (50-79%)  ${padL(confBuckets.mid, 4)}  ${pct(confBuckets.mid, total)}`);
  out.push(`  Low  (<50%)    ${padL(confBuckets.low, 4)}  ${pct(confBuckets.low, total)}`);
  out.push(`  N/A            ${padL(confBuckets.none, 4)}  ${pct(confBuckets.none, total)}`);
  out.push('');

  // ── bottom line ────────────────────────────────────────────────────────

  const totalFields = rows.reduce((s, r) => s + countFields(r), 0);
  const maxFields = total * 5;

  out.push(dblBar);
  out.push(
    `  ${counts.complete} complete  |  ${counts.partial} partial  |  ${counts.failed} failed  |  ${counts.timeout} timeout`,
  );
  out.push(
    `  Field fill: ${totalFields}/${maxFields} (${pct(totalFields, maxFields).trim()})   Grade: ${grade}`,
  );
  out.push(dblBar);
  out.push('');

  console.log(out.join('\n'));
}

main();
