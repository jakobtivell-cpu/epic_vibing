/**
 * Optional end-to-end scrape over every ticker in data/ticker.json.
 *
 * Each company runs in a subprocess with a hard wall-clock limit of 3 minutes
 * (same mechanism as `scrape.ts --timeout-per-company`).
 *
 * This is skipped in normal `npm test` because it hits the network for a long time.
 *
 * Run (cross-platform):
 *   npm run test:e2e-all-tickers
 *
 * Or set the env yourself, then run Jest on this file with --runInBand and a
 * high --testTimeout (full run can take many hours).
 */

import {
  buildCompanyProfilesForEveryTickerEntry,
  SCRAPE_TIMEOUT_PER_COMPANY_MS,
} from '../src/data/all-ticker-companies';
import { loadTickerMap } from '../src/data/ticker-map';
import { runCompaniesWithOptionalChildTimeout } from '../src/cli/child-runner';
import type { PipelineResult } from '../src/types';

const RUN_E2E = process.env.RUN_ALL_TICKERS_SCRAPE_E2E === '1';

describe('all ticker companies (from ticker.json)', () => {
  it('builds a non-empty deduped list after loadTickerMap', () => {
    loadTickerMap();
    const companies = buildCompanyProfilesForEveryTickerEntry();
    expect(companies.length).toBeGreaterThan(10);
    expect(companies.every((c) => c.name.trim().length > 0)).toBe(true);
  });
});

const describeE2e = RUN_E2E ? describe : describe.skip;

describeE2e('E2E: scrape every ticker (3 min cap per company)', () => {
  let results: PipelineResult[];

  beforeAll(async () => {
    const companies = buildCompanyProfilesForEveryTickerEntry();
    // Upper bound for hook: all companies × 3 min + headroom (Jest hook timeout).
    jest.setTimeout(companies.length * SCRAPE_TIMEOUT_PER_COMPANY_MS + 600_000);

    results = await runCompaniesWithOptionalChildTimeout(
      companies,
      false,
      { sequential: true, llmChallengerForce: false },
      SCRAPE_TIMEOUT_PER_COMPANY_MS,
    );
  }, 24 * 60 * 60 * 1000);

  it('returns one result per deduped company', () => {
    const n = buildCompanyProfilesForEveryTickerEntry().length;
    expect(results.length).toBe(n);
  });

  it('child timeout rows report the configured wall clock (3 min)', () => {
    for (const r of results) {
      if (r.status === 'timeout') {
        expect(r.extractionNotes.some((x) => /Pipeline timed out after \d+ms/.test(x))).toBe(true);
        expect(
          r.extractionNotes.some((x) => x.includes(`${SCRAPE_TIMEOUT_PER_COMPANY_MS}ms`)),
        ).toBe(true);
      }
    }
  });

  it('produces at least one complete or partial row (sanity)', () => {
    const ok = results.filter((r) => r.status === 'complete' || r.status === 'partial');
    expect(ok.length).toBeGreaterThan(0);
  });
});
