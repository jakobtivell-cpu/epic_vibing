// ---------------------------------------------------------------------------
// Pure guards for numeric extraction artifacts (fused years, unit inflation).
// Used by field-extractor and covered by unit tests.
// ---------------------------------------------------------------------------

/** Detects integers like 20252024000 where year digits were fused into a “revenue”. */
export function isFusedYearIntegerCorruption(n: number): boolean {
  if (!Number.isFinite(n)) return false;
  const s = String(Math.trunc(Math.abs(n)));
  return /(20\d{2}){2,}/.test(s);
}

/** Above this (MSEK field value), assume tkr/KSEK read as MSEK and apply ÷1000 once. */
const MEGASCALE_MSEK_THRESHOLD: Record<'industrial' | 'bank' | 'investment_company' | 'real_estate', number> = {
  // Large Cap industrials rarely exceed ~1M MSEK; 1M was too aggressive (wrong table picks were mangled).
  industrial: 3_000_000,
  bank: 80_000_000,
  investment_company: 3_000_000,
  real_estate: 3_000_000,
};

/**
 * Parent-company lines in tkr/KSEK are sometimes parsed with consolidated MSEK context → ~1000× inflation.
 * When revenue is absurdly large in MSEK for the reporting model, scale down once.
 */
export function applyRevenueMegascaleMsekGuard(
  revenue: number,
  companyType: 'industrial' | 'bank' | 'investment_company' | 'real_estate' = 'industrial',
): {
  revenue: number;
  adjusted: boolean;
} {
  const threshold = MEGASCALE_MSEK_THRESHOLD[companyType];
  if (!Number.isFinite(revenue) || revenue <= threshold) {
    return { revenue, adjusted: false };
  }
  return { revenue: Math.round(revenue / 1000), adjusted: true };
}
