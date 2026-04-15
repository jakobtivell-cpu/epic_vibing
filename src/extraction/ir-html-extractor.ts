// ---------------------------------------------------------------------------
// IR page HTML key figures extractor — medium-confidence structured data
// extraction directly from investor relations web pages.
//
// Many IR pages show "Key figures at a glance" / "Nyckeltal" sections with
// revenue, profit, and employees in structured HTML tables or cards.
// This provides better-than-allabolag data when PDF discovery fails.
// ---------------------------------------------------------------------------

import * as cheerio from 'cheerio';
import { ExtractedData } from '../types';
import { fetchPage } from '../utils/http-client';
import { createLogger } from '../utils/logger';

const log = createLogger('ir-html');

export interface IrHtmlResult {
  data: ExtractedData;
  fiscalYear: number | null;
  sourceUrl: string;
  confidence: number;
}

const CURRENT_YEAR = new Date().getFullYear();

const KEY_FIGURES_SUBPAGES = [
  '/key-figures',
  '/nyckeltal',
  '/financial-summary',
  '/financial-highlights',
  '/key-data',
  '/in-brief',
  '/about/key-figures',
  '/about/in-brief',
  '/facts-and-figures',
];

const REVENUE_LABELS = /\b(revenue|net\s*sales|nettoomsättning|omsättning|total\s*revenue|net\s*revenue|total\s*income)\b/i;
const EBIT_LABELS = /\b(operating\s*(?:profit|income|result)|ebit|rörelseresultat)\b/i;
const EMPLOYEE_LABELS =
  /\b(employees|number\s*of\s*employees|our\s+people|workforce|antal\s*anställda|medelantal|medarbetare|headcount|average\s*fte|full[\s-]*time\s*equivalents?|heltidsekvivalenter|fte)\b/i;
const CEO_LABELS = /\b(ceo|president|chief\s*executive|verkställande\s*direktör|vd)\b/i;

function parseNumber(raw: string): number | null {
  let s = raw.trim().replace(/\s+/g, '');
  s = s.replace(/,(\d{3})/g, '$1');
  s = s.replace(/,/g, '.');

  const isNeg = /^[-–−]/.test(s);
  if (isNeg) s = s.replace(/^[-–−]\s*/, '');

  const num = parseFloat(s);
  if (isNaN(num) || !isFinite(num)) return null;
  return isNeg ? -num : num;
}

function detectUnit(text: string): string {
  const lower = text.toLowerCase();
  if (/\bksek\b|\btkr\b|\bthousand/i.test(lower)) return 'ksek';
  if (/\bbsek\b|\bmdr\b|\bmdkr\b|\bbillion/i.test(lower)) return 'bsek';
  if (/\bmsek\b|\bmkr\b|\bmillion/i.test(lower)) return 'msek';
  if (/\bsek\b|\bkr\b/i.test(lower)) return 'sek';
  if (/\beur\b|\b€/i.test(lower)) return /\bmillion\b|\bm\b/.test(lower) ? 'eur' : 'eur_raw';
  return 'msek';
}

function toMsek(value: number, unit: string): number {
  switch (unit) {
    case 'bsek': return Math.round(value * 1_000);
    case 'msek': return Math.round(value);
    case 'ksek': return Math.round(value / 1_000);
    case 'sek': return Math.round(value / 1_000_000);
    case 'eur': return Math.round(value * 11.5);
    case 'eur_raw': return Math.round(value * 11.5 / 1_000_000);
    default: return Math.round(value);
  }
}

function likelyYear(value: number): boolean {
  return value >= 1900 && value <= 2100;
}

/**
 * Attempt to extract key financial figures from an IR page and its
 * "key figures" sub-pages.
 */
export async function extractFromIrHtml(
  irPageUrl: string,
  companyName: string,
): Promise<IrHtmlResult | null> {
  log.info(`[${companyName}] Extracting key figures from IR HTML`);

  // Build list of pages to try: the IR page itself plus key-figures sub-pages
  const baseUrl = irPageUrl.replace(/\/$/, '');
  const pagesToFetch = [irPageUrl];

  // Also try key-figures sub-pages relative to the IR page
  let irBase: string;
  try {
    const u = new URL(irPageUrl);
    irBase = `${u.protocol}//${u.host}`;
  } catch {
    irBase = baseUrl;
  }

  for (const subpage of KEY_FIGURES_SUBPAGES) {
    pagesToFetch.push(`${baseUrl}${subpage}`);
    pagesToFetch.push(`${irBase}${subpage}`);
  }

  // Deduplicate
  const uniquePages = [...new Set(pagesToFetch)];

  let combinedHtml = '';
  let successfulUrl = irPageUrl;

  for (const pageUrl of uniquePages.slice(0, 8)) {
    try {
      const result = await fetchPage(pageUrl, 12_000);
      if (result.ok) {
        combinedHtml += '\n' + result.response.data;
        if (pageUrl !== irPageUrl) {
          successfulUrl = pageUrl;
        }
      }
    } catch { /* skip */ }
  }

  if (combinedHtml.length < 500) {
    log.info(`[${companyName}] IR HTML too short for extraction`);
    return null;
  }

  const $ = cheerio.load(combinedHtml);

  let revenue: number | null = null;
  let ebit: number | null = null;
  let employees: number | null = null;
  let ceo: string | null = null;
  let fiscalYear: number | null = null;

  // Detect the unit context from the page (many pages have a note like "SEK M" or "MSEK")
  const pageText = $('body').text();
  const pageUnit = detectUnit(pageText.substring(0, 5000));

  // Strategy 1: Scan tables for labeled rows
  $('table').each((_, table) => {
    const rows = $(table).find('tr');
    rows.each((_, row) => {
      const cells = $(row).find('td, th').toArray();
      if (cells.length < 2) return;

      const label = $(cells[0]).text().trim();
      // Take the last numeric cell (most recent year)
      let valueText: string | null = null;
      for (let i = cells.length - 1; i >= 1; i--) {
        const t = $(cells[i]).text().trim();
        if (/\d/.test(t)) {
          valueText = t;
          break;
        }
      }
      if (!valueText) return;

      const num = parseNumber(valueText);
      if (num === null) return;

      if (revenue === null && REVENUE_LABELS.test(label)) {
        revenue = toMsek(num, pageUnit);
        log.debug(`[${companyName}] IR HTML revenue (table): ${revenue} MSEK`);
      }
      if (ebit === null && EBIT_LABELS.test(label)) {
        ebit = toMsek(num, pageUnit);
        log.debug(`[${companyName}] IR HTML EBIT (table): ${ebit} MSEK`);
      }
      if (employees === null && EMPLOYEE_LABELS.test(label)) {
        if (num >= 50 && num < 1_000_000 && !likelyYear(num)) {
          employees = Math.round(num);
          log.debug(`[${companyName}] IR HTML employees (table): ${employees}`);
        }
      }
    });
  });

  // Strategy 2: Definition lists and labeled div/span pairs
  $('dl, [class*="key"], [class*="figure"], [class*="fact"], [class*="highlight"], [class*="nyckeltal"]').each((_, el) => {
    const text = $(el).text();
    const lines = text.split(/\n/).map((l) => l.trim()).filter((l) => l.length > 0);

    for (let i = 0; i < lines.length - 1; i++) {
      const label = lines[i];
      const value = lines[i + 1];

      const num = parseNumber(value);
      if (num === null) continue;

      if (revenue === null && REVENUE_LABELS.test(label)) {
        revenue = toMsek(num, pageUnit);
        log.debug(`[${companyName}] IR HTML revenue (dl/div): ${revenue} MSEK`);
      }
      if (ebit === null && EBIT_LABELS.test(label)) {
        ebit = toMsek(num, pageUnit);
        log.debug(`[${companyName}] IR HTML EBIT (dl/div): ${ebit} MSEK`);
      }
      if (employees === null && EMPLOYEE_LABELS.test(label)) {
        if (num >= 50 && num < 1_000_000 && !likelyYear(num)) {
          employees = Math.round(num);
          log.debug(`[${companyName}] IR HTML employees (dl/div): ${employees}`);
        }
      }
    }
  });

  // Strategy 3: Text-based scan for CEO
  const bodyLines = pageText.split(/\n/).map((l) => l.trim()).filter((l) => l.length > 0 && l.length < 300);
  for (const line of bodyLines) {
    if (ceo) break;
    if (!CEO_LABELS.test(line)) continue;

    const nameMatch = line.match(
      /(?:ceo|president|vd|verkställande\s+direktör)[:\s]+([A-ZÅÄÖÉÜ][a-zåäöéü]+(?:\s+(?:von\s+|af\s+|de\s+)?[A-ZÅÄÖÉÜ][a-zåäöéü]+){1,3})/i,
    );
    if (nameMatch) {
      ceo = nameMatch[1].trim();
      log.debug(`[${companyName}] IR HTML CEO: ${ceo}`);
    }
  }

  // Fiscal year detection
  const yearMatches = pageText.match(/\b(20[12]\d)\b/g);
  if (yearMatches) {
    const years = [...new Set(yearMatches.map(Number))]
      .filter((y) => y >= 2020 && y <= CURRENT_YEAR)
      .sort((a, b) => b - a);
    fiscalYear = years[0] ?? null;
  }

  const fieldsFound = [revenue, ebit, employees, ceo].filter((f) => f !== null).length;
  if (fieldsFound === 0) {
    log.info(`[${companyName}] No key figures found in IR HTML`);
    return null;
  }

  // Revenue plausibility for large-cap
  if (revenue !== null && (revenue < 500 || revenue > 5_000_000)) {
    log.warn(`[${companyName}] IR HTML revenue ${revenue} MSEK seems implausible — discarding`);
    revenue = null;
  }

  const confidence = Math.min(70, 30 + fieldsFound * 10);
  log.info(`[${companyName}] IR HTML extraction: ${fieldsFound}/4 fields, confidence ${confidence}%`);

  return {
    data: {
      revenue_msek: revenue,
      ebit_msek: ebit,
      employees,
      ceo,
      fiscal_year: fiscalYear,
    },
    fiscalYear,
    sourceUrl: successfulUrl,
    confidence,
  };
}
