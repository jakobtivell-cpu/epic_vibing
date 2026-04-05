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
    fallbackStepReached: r.fallbackStepReached,
    detectedCompanyType: r.detectedCompanyType,
    cached: r.cached,
    cachedAt: r.cachedAt,
    extractionNotes: r.extractionNotes,
    ...(r.dualTrackAdjudication ? { dualTrackAdjudication: r.dualTrackAdjudication } : {}),
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
    newRowMap.set(r.company.toLowerCase(), toOutputRow(r));
  }

  const merged: Record<string, unknown>[] = existingRows.map((row) => {
    const company = String((row as { company?: string }).company ?? '').toLowerCase();
    return newRowMap.get(company) ?? row;
  });

  const existingCompanies = new Set(
    existingRows.map((row) =>
      String((row as { company?: string }).company ?? '').toLowerCase(),
    ),
  );
  for (const [company, row] of newRowMap) {
    if (!existingCompanies.has(company)) {
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
// Run outcome classification (batch dashboards, no-PDF vs bad extraction)
// ---------------------------------------------------------------------------

export type FailureClass =
  | 'complete'
  | 'partial_pdf'
  | 'allabolag_partial'
  | 'no_ir'
  | 'no_pdf'
  | 'download_failed'
  | 'extraction_failed'
  | 'validation_failed'
  | 'failed_other';

export function classifyFailureClass(r: PipelineResult): FailureClass {
  if (r.status === 'complete') return 'complete';

  if (r.stages) {
    if (r.stages.irDiscovery?.status === 'failed') return 'no_ir';
    if (r.stages.reportDiscovery?.status === 'failed') return 'no_pdf';
    if (r.stages.download?.status === 'failed') return 'download_failed';
    if (r.stages.extraction?.status === 'failed') return 'extraction_failed';
    if (r.stages.validation?.status === 'failed') return 'validation_failed';
  }

  if (r.dataSource === 'allabolag') return 'allabolag_partial';
  if (r.dataSource === 'ir-html') return 'partial_pdf';
  if (r.status === 'partial') return 'partial_pdf';

  return 'failed_other';
}

function tallyFailureBuckets(
  results: PipelineResult[],
): Record<FailureClass, number> {
  const keys: FailureClass[] = [
    'complete',
    'partial_pdf',
    'allabolag_partial',
    'no_ir',
    'no_pdf',
    'download_failed',
    'extraction_failed',
    'validation_failed',
    'failed_other',
  ];
  const init = {} as Record<FailureClass, number>;
  for (const k of keys) init[k] = 0;
  for (const r of results) {
    init[classifyFailureClass(r)]++;
  }
  return init;
}

// ---------------------------------------------------------------------------
// run_summary.json
// ---------------------------------------------------------------------------

export function writeRunSummary(results: PipelineResult[]): void {
  const complete = results.filter((r) => r.status === 'complete').length;
  const partial = results.filter((r) => r.status === 'partial').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const failureBuckets = tallyFailureBuckets(results);

  const perCompany = results.map((r) => {
    const failedStage = r.stages
      ? Object.entries(r.stages).find(([, s]) => s?.status === 'failed')
      : undefined;
    return {
      company: r.company,
      ticker: r.ticker,
      status: r.status,
      confidence: r.confidence,
      dataSource: r.dataSource,
      fieldsExtracted: countFields(r),
      failureClass: classifyFailureClass(r),
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
    failureBuckets,
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

  if (r.status !== 'complete') {
    parts.push(`class=${classifyFailureClass(r)}`);
  }
  if (r.fallbackStepReached) parts.push(`step=${r.fallbackStepReached}`);
  if (r.dataSource === 'allabolag') parts.push('allabolag data');
  if (r.dataSource === 'ir-html') parts.push('IR HTML data');
  if (r.dataSource === 'playwright+pdf') parts.push('playwright fallback');
  if (r.extractedData && r.stages?.extraction?.status === 'partial') parts.push('partial extraction');
  if (r.detectedCompanyType && r.detectedCompanyType !== 'industrial') parts.push(r.detectedCompanyType);
  if (r.cached) parts.push('CACHED');

  return parts.join(', ');
}

function failedAtLabel(r: PipelineResult): string {
  if (!r.stages) return 'failed';
  const stageOrder = ['irDiscovery', 'reportDiscovery', 'download', 'extraction', 'validation'] as const;
  for (const name of stageOrder) {
    const stage = r.stages[name];
    if (stage?.status === 'failed') {
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
  const fb = tallyFailureBuckets(results);
  const fbStr = Object.entries(fb)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join('  ');
  if (fbStr) {
    lines.push(`  By class: ${fbStr}`);
  }
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

    lines.push(`  ${r.company}${r.ticker ? ` (${r.ticker})` : ''}`);
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
