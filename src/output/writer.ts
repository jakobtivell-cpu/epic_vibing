// ---------------------------------------------------------------------------
// Output writer — persists results.json and run_summary.json, prints a
// human-readable summary. All writes are atomic (temp file → rename).
// Supports partial reruns: merge a single-company result into existing data.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PipelineResult, ResultStatus } from '../types';
import { RESULTS_PATH, RUN_SUMMARY_PATH, OUTPUT_DIR } from '../config/settings';
import { createLogger } from '../utils/logger';

const log = createLogger('output');

// ---------------------------------------------------------------------------
// Public JSON schema mapping (strips internal `stages`)
// ---------------------------------------------------------------------------

function toOutputRow(r: PipelineResult): Record<string, unknown> {
  return {
    company: r.company,
    ticker: r.ticker,
    website: r.website,
    irPage: r.irPage,
    annualReportUrl: r.annualReportUrl,
    annualReportDownloaded: r.annualReportDownloaded,
    fiscalYear: r.fiscalYear,
    extractedData: r.extractedData,
    sustainability: r.sustainability,
    dataSource: r.dataSource,
    confidence: r.confidence,
    status: r.status,
    extractionNotes: r.extractionNotes,
  };
}

// ---------------------------------------------------------------------------
// Atomic write helper — write to temp file in the same directory, then rename
// ---------------------------------------------------------------------------

function atomicWriteJson(filepath: string, data: unknown): void {
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = path.join(dir, `.tmp_${path.basename(filepath)}_${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filepath);
}

// ---------------------------------------------------------------------------
// results.json — write / merge
// ---------------------------------------------------------------------------

export function writeResults(results: PipelineResult[]): void {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    companyCount: results.length,
    results: results.map(toOutputRow),
  };

  atomicWriteJson(RESULTS_PATH, payload);
  log.info(`Results written to ${RESULTS_PATH}`);
}

/**
 * Merge new results into the existing results.json.
 * Replaces rows whose ticker matches; appends rows that are new.
 * Used for --ticker single-company reruns.
 */
export function mergeResults(newResults: PipelineResult[]): void {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  let existingRows: Record<string, unknown>[] = [];

  if (fs.existsSync(RESULTS_PATH)) {
    try {
      const raw = fs.readFileSync(RESULTS_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      existingRows = Array.isArray(parsed) ? parsed : parsed.results ?? [];
    } catch {
      log.warn('Could not parse existing results.json — overwriting');
    }
  }

  const newRowMap = new Map<string, Record<string, unknown>>();
  for (const r of newResults) {
    newRowMap.set(r.ticker.toUpperCase(), toOutputRow(r));
  }

  const merged: Record<string, unknown>[] = existingRows.map((row) => {
    const ticker = String((row as { ticker?: string }).ticker ?? '').toUpperCase();
    return newRowMap.get(ticker) ?? row;
  });

  const existingTickers = new Set(
    existingRows.map((row) =>
      String((row as { ticker?: string }).ticker ?? '').toUpperCase(),
    ),
  );
  for (const [ticker, row] of newRowMap) {
    if (!existingTickers.has(ticker)) {
      merged.push(row);
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    companyCount: merged.length,
    results: merged,
  };

  atomicWriteJson(RESULTS_PATH, payload);
  log.info(`Merged ${newResults.length} result(s) into ${RESULTS_PATH} (${merged.length} total)`);
}

// ---------------------------------------------------------------------------
// run_summary.json
// ---------------------------------------------------------------------------

export function writeRunSummary(results: PipelineResult[]): void {
  const complete = results.filter((r) => r.status === 'complete').length;
  const partial = results.filter((r) => r.status === 'partial').length;
  const failed = results.filter((r) => r.status === 'failed').length;

  const perCompany = results.map((r) => {
    const failedStage = Object.entries(r.stages).find(
      ([, s]) => s.status === 'failed',
    );
    return {
      company: r.company,
      ticker: r.ticker,
      status: r.status,
      confidence: r.confidence,
      dataSource: r.dataSource,
      fieldsExtracted: countFields(r),
      failedAtStage: failedStage ? failedStage[0] : null,
      errorSummary: failedStage?.[1].error ?? null,
    };
  });

  const summary = {
    timestamp: new Date().toISOString(),
    companiesProcessed: results.length,
    complete,
    partial,
    failed,
    companies: perCompany,
  };

  atomicWriteJson(RUN_SUMMARY_PATH, summary);
  log.info(`Run summary written to ${RUN_SUMMARY_PATH}`);
}

// ---------------------------------------------------------------------------
// Console summary — formatted with status icons
// ---------------------------------------------------------------------------

function countFields(r: PipelineResult): number {
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

function statusIcon(s: ResultStatus): string {
  switch (s) {
    case 'complete': return '\u2713'; // ✓
    case 'partial':  return '\u25B3'; // △
    case 'failed':   return '\u2717'; // ✗
  }
}

function statusDetail(r: PipelineResult): string {
  const fields = countFields(r);
  const parts: string[] = [`${fields}/5 fields`];

  if (r.dataSource === 'allabolag') parts.push('allabolag data');
  if (r.dataSource === 'playwright+pdf') parts.push('playwright fallback');
  if (r.extractedData && r.stages.extraction.status === 'partial') parts.push('partial extraction');

  const companyType = inferCompanyTypeTag(r);
  if (companyType) parts.push(companyType);

  return parts.join(', ');
}

function inferCompanyTypeTag(r: PipelineResult): string | null {
  for (const note of r.extractionNotes) {
    if (/investment company/i.test(note)) return 'investment company';
    if (/bank/i.test(note)) return 'bank schema';
  }
  return null;
}

function failedAtLabel(r: PipelineResult): string {
  const stageOrder = ['irDiscovery', 'reportDiscovery', 'download', 'extraction', 'validation'] as const;
  for (const name of stageOrder) {
    const stage = r.stages[name];
    if (stage.status === 'failed') {
      const labels: Record<string, string> = {
        irDiscovery: 'IR discovery',
        reportDiscovery: 'report discovery',
        download: 'download',
        extraction: 'extraction',
        validation: 'validation',
      };
      return `failed at ${labels[name]}`;
    }
  }
  return 'failed';
}

export function printRunSummary(results: PipelineResult[]): void {
  const complete = results.filter((r) => r.status === 'complete').length;
  const partial = results.filter((r) => r.status === 'partial').length;
  const failed = results.filter((r) => r.status === 'failed').length;

  const dblBar = '\u2550'.repeat(42); // ══════
  const sglBar = '\u2500'.repeat(42); // ──────
  const now = new Date().toISOString();

  const lines: string[] = [
    '',
    dblBar,
    `  Run Complete: ${now}`,
    sglBar,
  ];

  for (const r of results) {
    const icon = statusIcon(r.status);
    const name = r.company.padEnd(16);

    if (r.status === 'failed') {
      lines.push(`  ${icon} ${name}\u2014 ${failedAtLabel(r)}`);
    } else {
      lines.push(`  ${icon} ${name}\u2014 ${r.status} (${statusDetail(r)})`);
    }
  }

  lines.push(sglBar);
  lines.push(`  Complete: ${complete}  |  Partial: ${partial}  |  Failed: ${failed}`);
  lines.push(dblBar);

  // Detailed data per company
  lines.push('');
  for (const r of results) {
    const d = r.extractedData;
    if (!d) continue;

    const rev = d.revenue_msek !== null ? `${d.revenue_msek.toLocaleString()} MSEK` : '\u2014';
    const ebit = d.ebit_msek !== null ? `${d.ebit_msek.toLocaleString()} MSEK` : '\u2014';
    const emp = d.employees !== null ? d.employees.toLocaleString() : '\u2014';
    const ceo = d.ceo ?? '\u2014';
    const fy = r.fiscalYear !== null ? String(r.fiscalYear) : '\u2014';
    const conf = r.confidence !== null ? `${r.confidence}%` : 'N/A';
    const src = r.dataSource ?? '\u2014';

    lines.push(`  ${r.company} (${r.ticker})`);
    lines.push(`    Revenue: ${rev}  |  EBIT: ${ebit}`);
    lines.push(`    Employees: ${emp}  |  CEO: ${ceo}`);
    lines.push(`    FY: ${fy}  |  Confidence: ${conf}  |  Source: ${src}`);

    const s = r.sustainability;
    if (s.scope1_co2_tonnes !== null || s.scope2_co2_tonnes !== null) {
      const s1 = s.scope1_co2_tonnes !== null ? `${s.scope1_co2_tonnes.toLocaleString()}t` : '\u2014';
      const s2 = s.scope2_co2_tonnes !== null ? `${s.scope2_co2_tonnes.toLocaleString()}t` : '\u2014';
      const meth = s.methodology ?? '\u2014';
      lines.push(`    Scope 1: ${s1}  |  Scope 2: ${s2}  (${meth})`);
    }

    lines.push('');
  }

  console.log(lines.join('\n'));
}
