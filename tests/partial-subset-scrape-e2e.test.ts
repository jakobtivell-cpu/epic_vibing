/**
 * Optional end-to-end scrape over the known partial subset.
 *
 * Each company runs in a subprocess with a hard wall-clock limit of 3 minutes.
 * This suite is skipped in normal `npm test`.
 *
 * Run:
 *   npm run test:e2e-partial-subset
 */

import {
  buildCompanyProfilesForTickers,
  SCRAPE_TIMEOUT_PER_COMPANY_MS,
} from '../src/data/all-ticker-companies';
import { PARTIAL_SUBSET_TICKERS } from '../src/data/partial-subset-tickers';
import { loadTickerMap } from '../src/data/ticker-map';
import { runCompaniesWithOptionalChildTimeout } from '../src/cli/child-runner';
import type { PipelineResult } from '../src/types';

const RUN_E2E = process.env.RUN_PARTIAL_SUBSET_SCRAPE_E2E === '1';

describe('partial ticker subset', () => {
  it('builds a non-empty deduped list from the partial ticker set', () => {
    loadTickerMap();
    const companies = buildCompanyProfilesForTickers([...PARTIAL_SUBSET_TICKERS]);
    expect(PARTIAL_SUBSET_TICKERS.length).toBe(54);
    expect(companies.length).toBeGreaterThan(20);
    expect(companies.every((c) => c.name.trim().length > 0)).toBe(true);
  });
});

const describeE2e = RUN_E2E ? describe : describe.skip;

describeE2e('E2E: scrape partial subset (3 min cap per company)', () => {
  let results: PipelineResult[];

  beforeAll(async () => {
    const companies = buildCompanyProfilesForTickers([...PARTIAL_SUBSET_TICKERS]);
    jest.setTimeout(companies.length * SCRAPE_TIMEOUT_PER_COMPANY_MS + 600_000);

    results = await runCompaniesWithOptionalChildTimeout(
      companies,
      false,
      { sequential: true, llmChallengerForce: false },
      SCRAPE_TIMEOUT_PER_COMPANY_MS,
    );
  }, 24 * 60 * 60 * 1000);

  it('returns one result per deduped company in subset', () => {
    const n = buildCompanyProfilesForTickers([...PARTIAL_SUBSET_TICKERS]).length;
    expect(results.length).toBe(n);
  });

  it('child timeout rows report the configured wall clock (3 min)', () => {
    for (const r of results) {
      if (r.status === 'timeout') {
        expect(r.extractionNotes.some((x) => /Pipeline timed out after \d+ms/.test(x))).toBe(true);
        expect(r.extractionNotes.some((x) => x.includes(`${SCRAPE_TIMEOUT_PER_COMPANY_MS}ms`))).toBe(
          true,
        );
      }
    }
  });

  it('produces at least one complete or partial row (sanity)', () => {
    const ok = results.filter((r) => r.status === 'complete' || r.status === 'partial');
    expect(ok.length).toBeGreaterThan(0);
  });
});
