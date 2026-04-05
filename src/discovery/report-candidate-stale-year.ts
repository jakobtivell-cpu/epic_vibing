// ---------------------------------------------------------------------------
// Drop PDF link candidates that clearly advertise an outdated fiscal/calendar
// year in the URL or anchor text (generic — no company-specific rules).
// ---------------------------------------------------------------------------

const YEAR_RE = /\b(20[12]\d)\b/g;

/**
 * True if any 20xx year in `url` or `text` is strictly before `calendarYear - 2`
 * (e.g. for 2026, 2023 and older trigger — 2024+ are kept).
 */
export function candidateUrlsOrTextImpliesStaleReport(
  url: string,
  text: string,
  calendarYear: number = new Date().getFullYear(),
): boolean {
  const cutoff = calendarYear - 2;
  const hay = `${url} ${text}`;
  const matches = hay.match(YEAR_RE);
  if (!matches) return false;
  return matches.some((y) => Number(y) < cutoff);
}
