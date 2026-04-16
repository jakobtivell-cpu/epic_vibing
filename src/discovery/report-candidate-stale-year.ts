// ---------------------------------------------------------------------------
// Drop PDF link candidates that clearly advertise an outdated fiscal/calendar
// year in the URL or anchor text (generic — no company-specific rules).
// ---------------------------------------------------------------------------

const YEAR_RE = /\b((?:19|20)\d{2})\b/g;
const SHORT_RANGE_RE = /\b(\d{2})[-_](\d{2})\b/g;
const CONCAT_SHORT_RANGE_RE = /\b(\d{2})(\d{2})\b/g;

function normalizeTwoDigitYear(twoDigitYear: number, calendarYear: number): number {
  const currentCentury = Math.floor(calendarYear / 100) * 100;
  let year = currentCentury + twoDigitYear;
  if (year > calendarYear + 1) year -= 100;
  return year;
}

function collectExplicitYears(haystack: string): number[] {
  const matches = haystack.match(YEAR_RE);
  if (!matches) return [];
  return matches.map((y) => Number(y));
}

function collectShortRangeEndYears(haystack: string, calendarYear: number): number[] {
  const years: number[] = [];

  for (const m of haystack.matchAll(SHORT_RANGE_RE)) {
    const end = Number(m[2]);
    years.push(normalizeTwoDigitYear(end, calendarYear));
  }

  for (const m of haystack.matchAll(CONCAT_SHORT_RANGE_RE)) {
    const token = m[0];
    // Avoid re-parsing 20xx years already covered by YEAR_RE.
    if (/^20\d{2}$/.test(token)) continue;
    const start = Number(m[1]);
    const end = Number(m[2]);
    // Require an increasing range shape like 09-10 / 1213 / 2425.
    if (end !== ((start + 1) % 100)) continue;
    years.push(normalizeTwoDigitYear(end, calendarYear));
  }

  return years;
}

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
  const explicitYears = collectExplicitYears(hay);
  if (explicitYears.some((y) => y < cutoff)) return true;

  // Legacy annual report URLs often encode years as 2-digit ranges (e.g. 09-10, 1213).
  // Treat them as stale only when no modern 20xx year is present in the same candidate.
  if (explicitYears.length === 0) {
    const shortRangeYears = collectShortRangeEndYears(hay, calendarYear);
    if (shortRangeYears.some((y) => y < cutoff)) return true;
  }

  return false;
}
