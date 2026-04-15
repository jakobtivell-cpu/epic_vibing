/**
 * Overnight full-scrape E2E test — runs every ticker in data/ticker.json
 * with a generous per-company timeout, sized to complete within ~8 hours.
 *
 * Gated by RUN_OVERNIGHT_SCRAPE_E2E=1; skipped in normal `npm test`.
 *
 * Env vars:
 *   RUN_OVERNIGHT_SCRAPE_E2E=1        Required to enable the long-running suite
 *   OVERNIGHT_CONCURRENCY=<n>         Parallel subprocess slots (default: 3)
 *   OVERNIGHT_TIMEOUT_PER_COMPANY=<ms> Per-company wall clock (default: 210000 = 3.5 min)
 *
 * Run via helper script:
 *   node scripts/run-overnight-scrape.cjs
 *   node scripts/run-overnight-scrape.cjs --concurrency 5
 *   node scripts/run-overnight-scrape.cjs --timeout-per-company 300000
 *
 * Or manually:
 *   RUN_OVERNIGHT_SCRAPE_E2E=1 npx jest tests/overnight-full-scrape.test.ts --runInBand --testTimeout=32400000
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  buildCompanyProfilesForEveryTickerEntry,
} from '../src/data/all-ticker-companies';
import { loadTickerMap } from '../src/data/ticker-map';
import { runCompaniesWithOptionalChildTimeout } from '../src/cli/child-runner';
import { PROJECT_ROOT, OUTPUT_DIR, RESULTS_PATH, RUN_SUMMARY_PATH } from '../src/config/settings';
import type { PipelineResult } from '../src/types';

const RUN_OVERNIGHT = process.env.RUN_OVERNIGHT_SCRAPE_E2E === '1';

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim().length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer when set`);
  }
  return parsed;
}

const CONCURRENCY = readPositiveIntEnv('OVERNIGHT_CONCURRENCY', 3);
const TIMEOUT_PER_COMPANY_MS = readPositiveIntEnv('OVERNIGHT_TIMEOUT_PER_COMPANY', 210_000);

// 8 hours in ms — Jest hook upper bound
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

function statusCounts(rows: PipelineResult[]) {
  const counts = { complete: 0, partial: 0, failed: 0, timeout: 0 };
  for (const r of rows) {
    if (r.status in counts) {
      counts[r.status as keyof typeof counts]++;
    }
  }
  return counts;
}

function pct(part: number, total: number): string {
  if (total === 0) return '0.0';
  return ((part / total) * 100).toFixed(1);
}

function writeRunSummary(results: PipelineResult[], durationMs: number): void {
  const counts = statusCounts(results);
  const total = results.length;
  const summary = {
    timestamp: new Date().toISOString(),
    durationMs,
    durationHuman: `${(durationMs / 3_600_000).toFixed(2)}h`,
    totalCompanies: total,
    concurrency: CONCURRENCY,
    timeoutPerCompanyMs: TIMEOUT_PER_COMPANY_MS,
    counts,
    rates: {
      complete: `${pct(counts.complete, total)}%`,
      partial: `${pct(counts.partial, total)}%`,
      failed: `${pct(counts.failed, total)}%`,
      timeout: `${pct(counts.timeout, total)}%`,
    },
    nullFields: {
      revenue: results.filter((r) => !r.extractedData?.revenue_msek).length,
      ebit: results.filter((r) => !r.extractedData?.ebit_msek).length,
      employees: results.filter((r) => !r.extractedData?.employees).length,
      ceo: results.filter((r) => !r.extractedData?.ceo).length,
      fiscal_year: results.filter((r) => !r.extractedData?.fiscal_year).length,
    },
    failedCompanies: results
      .filter((r) => r.status === 'failed')
      .map((r) => ({ company: r.company, ticker: r.ticker })),
    timeoutCompanies: results
      .filter((r) => r.status === 'timeout')
      .map((r) => ({ company: r.company, ticker: r.ticker })),
  };

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  fs.writeFileSync(RUN_SUMMARY_PATH, JSON.stringify(summary, null, 2), 'utf-8');
}

function writeResults(results: PipelineResult[]): void {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  const output = results.map((r) => {
    const { stages, ...rest } = r;
    return rest;
  });
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(output, null, 2), 'utf-8');
}

// --- Always-run sanity test (no network) ---

describe('overnight scrape setup', () => {
  it('builds a non-empty deduped company list', () => {
    loadTickerMap();
    const companies = buildCompanyProfilesForEveryTickerEntry();
    expect(companies.length).toBeGreaterThan(100);
    expect(companies.every((c) => c.name.trim().length > 0)).toBe(true);
  });

  it('per-company timeout fits within 8-hour budget', () => {
    loadTickerMap();
    const n = buildCompanyProfilesForEveryTickerEntry().length;
    const worstCase = (n * TIMEOUT_PER_COMPANY_MS) / CONCURRENCY;
    expect(worstCase).toBeLessThanOrEqual(EIGHT_HOURS_MS);
  });
});

// --- Gated overnight E2E suite ---

const describeOvernight = RUN_OVERNIGHT ? describe : describe.skip;

describeOvernight(`overnight full scrape (${CONCURRENCY} concurrent, ${TIMEOUT_PER_COMPANY_MS / 1000}s cap)`, () => {
  let results: PipelineResult[];
  let durationMs: number;

  beforeAll(async () => {
    const companies = buildCompanyProfilesForEveryTickerEntry();

    console.log(`\n=== Overnight scrape starting ===`);
    console.log(`Companies: ${companies.length}`);
    console.log(`Concurrency: ${CONCURRENCY}`);
    console.log(`Timeout per company: ${TIMEOUT_PER_COMPANY_MS / 1000}s`);
    console.log(`Worst-case wall clock: ${((companies.length * TIMEOUT_PER_COMPANY_MS) / CONCURRENCY / 3_600_000).toFixed(1)}h`);
    console.log(`Started at: ${new Date().toISOString()}\n`);

    const t0 = Date.now();
    results = await runCompaniesWithOptionalChildTimeout(
      companies,
      false,
      { sequential: false, llmChallengerForce: false },
      TIMEOUT_PER_COMPANY_MS,
      CONCURRENCY,
    );
    durationMs = Date.now() - t0;

    console.log(`\n=== Overnight scrape finished ===`);
    console.log(`Duration: ${(durationMs / 3_600_000).toFixed(2)}h`);

    writeResults(results);
    writeRunSummary(results, durationMs);

    const counts = statusCounts(results);
    console.log(`Results: complete=${counts.complete} partial=${counts.partial} failed=${counts.failed} timeout=${counts.timeout}`);
    console.log(`Written to: ${RESULTS_PATH}`);
    console.log(`Summary:    ${RUN_SUMMARY_PATH}\n`);
  }, EIGHT_HOURS_MS + 600_000);

  it('returns one result per deduped company', () => {
    const n = buildCompanyProfilesForEveryTickerEntry().length;
    expect(results.length).toBe(n);
  });

  it('completes within the 8-hour budget', () => {
    expect(durationMs).toBeLessThanOrEqual(EIGHT_HOURS_MS);
  });

  it('timeout rows reference the configured wall-clock limit', () => {
    for (const r of results) {
      if (r.status === 'timeout') {
        expect(
          r.extractionNotes.some((n) => /Pipeline timed out after \d+ms/.test(n)),
        ).toBe(true);
      }
    }
  });

  it('produces at least 30% complete or partial results', () => {
    const ok = results.filter((r) => r.status === 'complete' || r.status === 'partial');
    expect(ok.length / results.length).toBeGreaterThanOrEqual(0.30);
  });

  it('no more than 60% timeouts', () => {
    const timeouts = results.filter((r) => r.status === 'timeout');
    expect(timeouts.length / results.length).toBeLessThan(0.60);
  });

  it('complete rows have all headline fields populated', () => {
    const complete = results.filter((r) => r.status === 'complete');
    for (const r of complete) {
      expect(r.extractedData).not.toBeNull();
      if (r.extractedData) {
        expect(r.extractedData.revenue_msek).not.toBeNull();
        expect(r.extractedData.ebit_msek).not.toBeNull();
        expect(r.extractedData.employees).not.toBeNull();
        expect(r.extractedData.fiscal_year).not.toBeNull();
      }
    }
  });

  it('prints a summary table to stdout', () => {
    const counts = statusCounts(results);
    const total = results.length;
    console.log('\n=== Overnight scrape quality report ===');
    console.log(`Total:    ${total}`);
    console.log(`Complete: ${counts.complete} (${pct(counts.complete, total)}%)`);
    console.log(`Partial:  ${counts.partial} (${pct(counts.partial, total)}%)`);
    console.log(`Failed:   ${counts.failed} (${pct(counts.failed, total)}%)`);
    console.log(`Timeout:  ${counts.timeout} (${pct(counts.timeout, total)}%)`);
    console.log(`Duration: ${(durationMs / 3_600_000).toFixed(2)} hours`);

    const nullRevenue = results.filter((r) => !r.extractedData?.revenue_msek).length;
    const nullEbit = results.filter((r) => !r.extractedData?.ebit_msek).length;
    const nullEmp = results.filter((r) => !r.extractedData?.employees).length;
    console.log(`\nNull fields: revenue=${nullRevenue} ebit=${nullEbit} employees=${nullEmp}`);
    console.log('===\n');
  });
});
