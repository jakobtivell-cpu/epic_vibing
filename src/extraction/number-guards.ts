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

/**
 * Parent-company lines in tkr/KSEK are sometimes parsed with consolidated MSEK context → ~1000× inflation.
 * When revenue is absurdly large in MSEK, scale down once.
 */
export function applyRevenueMegascaleMsekGuard(revenue: number): {
  revenue: number;
  adjusted: boolean;
} {
  if (!Number.isFinite(revenue) || revenue <= 1_000_000) {
    return { revenue, adjusted: false };
  }
  return { revenue: Math.round(revenue / 1000), adjusted: true };
}
