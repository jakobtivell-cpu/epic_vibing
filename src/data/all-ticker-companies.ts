// ---------------------------------------------------------------------------
// Build CompanyProfile[] from every key in data/ticker.json (deduped by
// legal entity). Used by the optional full-ticker E2E scrape test / scripts.
// ---------------------------------------------------------------------------

import type { CompanyProfile } from '../types';
import {
  loadTickerMap,
  getTickerMap,
  resolveTicker,
  normalizeTickerForLookup,
  resolveOrgNumber,
  resolveCandidateDomains,
  resolveIrPage,
  resolveIsin,
  resolveIrEmail,
  resolveCompanyType,
  resolveAnnualReportPdfUrls,
  resolveOverrideFiscalYear,
  resolveCmsApiUrls,
  resolveAggregatorUrls,
  resolveManualHeadlineFields,
} from './ticker-map';

/** Wall-clock cap per company when using `runCompaniesWithOptionalChildTimeout` (3 minutes). */
export const SCRAPE_TIMEOUT_PER_COMPANY_MS = 180_000;

/**
 * One profile per ticker key in the map, then dedupe by canonical legal name
 * (same rules as `scrape.ts` — multiple share classes → one run).
 */
export function buildCompanyProfilesForEveryTickerEntry(): CompanyProfile[] {
  loadTickerMap();
  const tickerMap = getTickerMap();
  const keys = Object.keys(tickerMap).sort((a, b) => a.localeCompare(b));
  return buildCompanyProfilesForTickers(keys);
}

/**
 * Build CompanyProfile[] from a selected ticker subset and dedupe by legal
 * entity (same dedupe rule as `scrape.ts`).
 */
export function buildCompanyProfilesForTickers(tickers: string[]): CompanyProfile[] {
  loadTickerMap();
  const keys = [...tickers].sort((a, b) => a.localeCompare(b));
  const profiles: CompanyProfile[] = [];

  for (const rawTicker of keys) {
    const legalName = resolveTicker(rawTicker);
    const canonicalTicker = normalizeTickerForLookup(rawTicker);
    const orgNumber = resolveOrgNumber(rawTicker) ?? undefined;
    const candidateDomains = resolveCandidateDomains(rawTicker) ?? undefined;
    const irPage = resolveIrPage(rawTicker) ?? undefined;
    const isin = resolveIsin(rawTicker) ?? undefined;
    const irEmail = resolveIrEmail(rawTicker) ?? undefined;
    const companyType = resolveCompanyType(rawTicker) ?? undefined;
    const annualReportPdfUrls = resolveAnnualReportPdfUrls(rawTicker) ?? undefined;
    const overrideFiscalYear = resolveOverrideFiscalYear(rawTicker) ?? undefined;
    const cmsApiUrls = resolveCmsApiUrls(rawTicker) ?? undefined;
    const aggregatorUrls = resolveAggregatorUrls(rawTicker) ?? undefined;
    const manualHeadlineFields = resolveManualHeadlineFields(rawTicker) ?? undefined;

    if (legalName) {
      profiles.push({
        name: legalName,
        ticker: canonicalTicker,
        legalName,
        orgNumber,
        ...(candidateDomains?.length ? { candidateDomains } : {}),
        ...(irPage ? { irPage } : {}),
        ...(isin ? { isin } : {}),
        ...(irEmail ? { irEmail } : {}),
        ...(companyType ? { companyType } : {}),
        ...(annualReportPdfUrls?.length ? { annualReportPdfUrls } : {}),
        ...(overrideFiscalYear ? { overrideFiscalYear } : {}),
        ...(cmsApiUrls?.length ? { cmsApiUrls } : {}),
        ...(aggregatorUrls?.length ? { aggregatorUrls } : {}),
        ...(manualHeadlineFields ? { manualHeadlineFields } : {}),
      });
    } else {
      profiles.push({ name: rawTicker.trim() });
    }
  }

  const seen = new Map<string, CompanyProfile>();
  for (const p of profiles) {
    const key = (p.legalName ?? p.name).toLowerCase();
    if (seen.has(key)) continue;
    seen.set(key, p);
  }

  return [...seen.values()];
}
