/**
 * Targeted re-scrape E2E — runs only the non-complete subset from the last
 * overnight batch and merges the fresh results back into results.json so that
 * already-complete rows are never overwritten.
 *
 * Gated by RUN_TARGETED_RESCRAPE_E2E=1; skipped in normal `npm test`.
 *
 * Env vars:
 *   RUN_TARGETED_RESCRAPE_E2E=1          Required to enable the suite
 *   TARGETED_RESCRAPE_CONCURRENCY=<n>    Parallel subprocess slots (default: 4)
 *   TARGETED_RESCRAPE_TIMEOUT=<ms>       Per-company wall clock   (default: 200000 = 3.3 min)
 *
 * Run via helper script:
 *   node scripts/run-targeted-rescrape.cjs
 *   node scripts/run-targeted-rescrape.cjs --concurrency 5 --timeout-per-company 240000
 *
 * After completion results are in output/results.json and output/run_summary.json.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildCompanyProfilesForTickers,
} from '../src/data/all-ticker-companies';
import { PARTIAL_SUBSET_TICKERS } from '../src/data/partial-subset-tickers';
import { loadTickerMap } from '../src/data/ticker-map';
import { runCompaniesWithOptionalChildTimeout } from '../src/cli/child-runner';
import { OUTPUT_DIR, RESULTS_PATH, RUN_SUMMARY_PATH } from '../src/config/settings';
import type { PipelineResult } from '../src/types';

const RUN = process.env.RUN_TARGETED_RESCRAPE_E2E === '1';

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim().length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer when set`);
  }
  return parsed;
}

const CONCURRENCY = readPositiveIntEnv('TARGETED_RESCRAPE_CONCURRENCY', 4);
const TIMEOUT_PER_COMPANY_MS = readPositiveIntEnv('TARGETED_RESCRAPE_TIMEOUT', 200_000);

// 2-hour wall-clock ceiling that Jest must not exceed
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

function statusCounts(rows: PipelineResult[]) {
  const counts = { complete: 0, partial: 0, failed: 0, timeout: 0 };
  for (const r of rows) {
    if (r.status in counts) counts[r.status as keyof typeof counts]++;
  }
  return counts;
}

function pct(part: number, total: number): string {
  if (total === 0) return '0.0';
  return ((part / total) * 100).toFixed(1);
}

function parseStoredResultsRows(raw: string): PipelineResult[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    const rows = Array.isArray(parsed)
      ? parsed
      : (parsed as { results?: unknown }).results;
    if (!Array.isArray(rows)) return [];
    return rows as PipelineResult[];
  } catch {
    return [];
  }
}

/**
 * Load the existing results.json keyed by ticker, then overwrite only the
 * tickers that were just re-scraped.  This preserves complete rows from the
 * last overnight run so the merged file always represents the best-known state.
 *
 * Accepts either a bare `PipelineResult[]` or the production envelope
 * `{ generatedAt, companyCount, results }`. Always writes the envelope shape.
 */
function mergeAndWriteResults(
  freshResults: PipelineResult[],
  resultsPath: string = RESULTS_PATH,
): PipelineResult[] {
  const dir = path.dirname(resultsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let existing: PipelineResult[] = [];
  if (fs.existsSync(resultsPath)) {
    try {
      existing = parseStoredResultsRows(fs.readFileSync(resultsPath, 'utf-8'));
    } catch {
      // malformed — start fresh
    }
  }

  const byTicker = new Map<string, PipelineResult>();
  for (const r of existing) {
    if (r.ticker) byTicker.set(r.ticker, r);
  }
  for (const r of freshResults) {
    if (r.ticker) byTicker.set(r.ticker, r);
  }

  const merged = [...byTicker.values()];
  const output = merged.map(({ stages, ...rest }) => rest);
  const payload = {
    generatedAt: new Date().toISOString(),
    companyCount: merged.length,
    results: output,
  };
  fs.writeFileSync(resultsPath, JSON.stringify(payload, null, 2), 'utf-8');
  return merged;
}

function writeRunSummary(
  freshResults: PipelineResult[],
  mergedResults: PipelineResult[],
  durationMs: number,
): void {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const freshCounts = statusCounts(freshResults);
  const mergedCounts = statusCounts(mergedResults);
  const freshTotal = freshResults.length;
  const mergedTotal = mergedResults.length;

  const summary = {
    timestamp: new Date().toISOString(),
    mode: 'targeted-rescrape',
    durationMs,
    durationHuman: `${(durationMs / 3_600_000).toFixed(2)}h`,
    subset: {
      totalCompanies: freshTotal,
      concurrency: CONCURRENCY,
      timeoutPerCompanyMs: TIMEOUT_PER_COMPANY_MS,
      counts: freshCounts,
      rates: {
        complete: `${pct(freshCounts.complete, freshTotal)}%`,
        partial: `${pct(freshCounts.partial, freshTotal)}%`,
        failed: `${pct(freshCounts.failed, freshTotal)}%`,
        timeout: `${pct(freshCounts.timeout, freshTotal)}%`,
      },
    },
    merged: {
      totalCompanies: mergedTotal,
      counts: mergedCounts,
      rates: {
        complete: `${pct(mergedCounts.complete, mergedTotal)}%`,
        partial: `${pct(mergedCounts.partial, mergedTotal)}%`,
        failed: `${pct(mergedCounts.failed, mergedTotal)}%`,
        timeout: `${pct(mergedCounts.timeout, mergedTotal)}%`,
      },
    },
    nullFields: {
      revenue: freshResults.filter((r) => !r.extractedData?.revenue_msek).length,
      ebit: freshResults.filter((r) => !r.extractedData?.ebit_msek).length,
      employees: freshResults.filter((r) => !r.extractedData?.employees).length,
      ceo: freshResults.filter((r) => !r.extractedData?.ceo).length,
      fiscal_year: freshResults.filter((r) => !r.extractedData?.fiscal_year).length,
    },
    failedCompanies: freshResults
      .filter((r) => r.status === 'failed')
      .map((r) => ({ company: r.company, ticker: r.ticker })),
    timeoutCompanies: freshResults
      .filter((r) => r.status === 'timeout')
      .map((r) => ({ company: r.company, ticker: r.ticker })),
  };

  fs.writeFileSync(RUN_SUMMARY_PATH, JSON.stringify(summary, null, 2), 'utf-8');
}

// --- Always-run sanity (no network) ---

describe('targeted rescrape setup', () => {
  it('subset list is non-empty and all tickers are strings', () => {
    loadTickerMap();
    const companies = buildCompanyProfilesForTickers([...PARTIAL_SUBSET_TICKERS]);
    expect(PARTIAL_SUBSET_TICKERS.length).toBeGreaterThan(0);
    expect(companies.length).toBeGreaterThan(0);
    expect(companies.every((c) => c.name.trim().length > 0)).toBe(true);
  });

  it('worst-case wall clock fits within 2-hour budget', () => {
    const n = PARTIAL_SUBSET_TICKERS.length;
    const worstCase = (n * TIMEOUT_PER_COMPANY_MS) / CONCURRENCY;
    expect(worstCase).toBeLessThanOrEqual(TWO_HOURS_MS);
  });
});

describe('mergeAndWriteResults envelope round-trip', () => {
  it('merges into envelope-shaped results.json and updates generatedAt / companyCount', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rescrape-merge-'));
    const tmpResults = path.join(tmpDir, 'results.json');

    fs.writeFileSync(
      tmpResults,
      JSON.stringify(
        {
          generatedAt: '2020-01-01T00:00:00.000Z',
          companyCount: 2,
          results: [
            { company: 'Alpha', ticker: 'AAA', status: 'complete' },
            { company: 'Beta', ticker: 'BBB', status: 'failed' },
          ],
        },
        null,
        2,
      ),
      'utf-8',
    );

    const fresh = {
      company: 'Alpha AB',
      ticker: 'AAA',
      status: 'partial',
    } as PipelineResult;

    mergeAndWriteResults([fresh], tmpResults);

    const roundTrip: {
      generatedAt: string;
      companyCount: number;
      results: { ticker: string; status: string; company: string }[];
    } = JSON.parse(fs.readFileSync(tmpResults, 'utf-8'));

    expect(roundTrip.companyCount).toBe(2);
    expect(Array.isArray(roundTrip.results)).toBe(true);
    expect(typeof roundTrip.generatedAt).toBe('string');
    expect(roundTrip.generatedAt).not.toBe('2020-01-01T00:00:00.000Z');

    const byTicker = Object.fromEntries(roundTrip.results.map((r) => [r.ticker, r]));
    expect(byTicker.BBB.status).toBe('failed');
    expect(byTicker.AAA.status).toBe('partial');
    expect(byTicker.AAA.company).toBe('Alpha AB');
  });

  it('supports legacy bare-array results.json', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rescrape-merge-'));
    const tmpResults = path.join(tmpDir, 'results.json');
    fs.writeFileSync(
      tmpResults,
      JSON.stringify([{ company: 'Old', ticker: 'OLD', status: 'complete' }], null, 2),
      'utf-8',
    );
    mergeAndWriteResults(
      [{ company: 'New', ticker: 'NEW', status: 'complete' } as PipelineResult],
      tmpResults,
    );
    const parsed = JSON.parse(fs.readFileSync(tmpResults, 'utf-8')) as {
      results: { ticker: string }[];
      companyCount: number;
    };
    expect(parsed.results).toHaveLength(2);
    expect(parsed.companyCount).toBe(2);
    const tickers = parsed.results.map((r) => r.ticker).sort();
    expect(tickers).toEqual(['NEW', 'OLD']);
  });
});

// --- Gated E2E suite ---

const describeE2e = RUN ? describe : describe.skip;

describeE2e(
  `targeted rescrape (${CONCURRENCY} concurrent, ${TIMEOUT_PER_COMPANY_MS / 1000}s cap)`,
  () => {
    let freshResults: PipelineResult[];
    let mergedResults: PipelineResult[];
    let durationMs: number;

    beforeAll(async () => {
      loadTickerMap();
      const companies = buildCompanyProfilesForTickers([...PARTIAL_SUBSET_TICKERS]);

      console.log(`\n=== Targeted rescrape starting ===`);
      console.log(`Subset:              ${companies.length} companies`);
      console.log(`Concurrency:         ${CONCURRENCY}`);
      console.log(`Timeout per company: ${TIMEOUT_PER_COMPANY_MS / 1000}s`);
      console.log(
        `Worst-case wall clock: ${((companies.length * TIMEOUT_PER_COMPANY_MS) / CONCURRENCY / 3_600_000).toFixed(2)}h`,
      );
      console.log(`Started at:          ${new Date().toISOString()}\n`);

      const t0 = Date.now();
      freshResults = await runCompaniesWithOptionalChildTimeout(
        companies,
        false,
        { sequential: false, llmChallengerForce: false },
        TIMEOUT_PER_COMPANY_MS,
        CONCURRENCY,
      );
      durationMs = Date.now() - t0;

      mergedResults = mergeAndWriteResults(freshResults);
      writeRunSummary(freshResults, mergedResults, durationMs);

      const freshCounts = statusCounts(freshResults);
      const mergedCounts = statusCounts(mergedResults);

      console.log(`\n=== Targeted rescrape finished ===`);
      console.log(`Duration: ${(durationMs / 3_600_000).toFixed(2)}h`);
      console.log(
        `Subset:   complete=${freshCounts.complete} partial=${freshCounts.partial} failed=${freshCounts.failed} timeout=${freshCounts.timeout}`,
      );
      console.log(
        `Merged:   complete=${mergedCounts.complete} partial=${mergedCounts.partial} failed=${mergedCounts.failed} timeout=${mergedCounts.timeout} (total=${mergedResults.length})`,
      );
      console.log(`Written to: ${RESULTS_PATH}`);
      console.log(`Summary:    ${RUN_SUMMARY_PATH}\n`);
    }, TWO_HOURS_MS + 300_000);

    it('returns one result per company in the subset', () => {
      const n = buildCompanyProfilesForTickers([...PARTIAL_SUBSET_TICKERS]).length;
      expect(freshResults.length).toBe(n);
    });

    it('completes within the 2-hour budget', () => {
      expect(durationMs).toBeLessThanOrEqual(TWO_HOURS_MS);
    });

    it('produces at least one complete or partial row (sanity)', () => {
      const ok = freshResults.filter((r) => r.status === 'complete' || r.status === 'partial');
      expect(ok.length).toBeGreaterThan(0);
    });

    it('complete rows have all headline fields populated', () => {
      for (const r of freshResults.filter((r) => r.status === 'complete')) {
        expect(r.extractedData).not.toBeNull();
        if (r.extractedData) {
          expect(r.extractedData.revenue_msek).not.toBeNull();
          expect(r.extractedData.fiscal_year).not.toBeNull();
        }
      }
    });

    it('prints a per-ticker summary table', () => {
      console.log('\n=== Per-ticker results ===');
      for (const r of freshResults) {
        const rev = r.extractedData?.revenue_msek ?? '-';
        const ebit = r.extractedData?.ebit_msek ?? '-';
        const emp = r.extractedData?.employees ?? '-';
        const ceo = r.extractedData?.ceo ? r.extractedData.ceo.slice(0, 30) : '-';
        const fy = r.extractedData?.fiscal_year ?? '-';
        console.log(
          `  ${(r.ticker ?? '?').padEnd(16)} ${r.status.padEnd(8)} rev=${String(rev).padStart(8)}  ebit=${String(ebit).padStart(8)}  emp=${String(emp).padStart(6)}  fy=${fy}  ceo=${ceo}`,
        );
      }
      console.log('===\n');
    });
  },
);
