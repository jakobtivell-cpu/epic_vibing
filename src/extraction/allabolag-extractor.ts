// ---------------------------------------------------------------------------
// Allabolag.se data extractor — scrapes statutory filing data as a LAST RESORT
// when no annual report PDF can be found via any discovery method.
//
// This provides partial financial data (revenue, operating result, employees)
// from public Swedish company registry filings. The data is less detailed than
// a full annual report but prevents blank result rows.
//
// Confidence is always "low" — these are secondary-source figures.
// ---------------------------------------------------------------------------

import * as cheerio from 'cheerio';
import { CompanyProfile, ExtractedData } from '../types';
import { fetchPage } from '../utils/http-client';
import { createLogger } from '../utils/logger';

const log = createLogger('allabolag');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface AllabolagResult {
  data: ExtractedData;
  fiscalYear: number | null;
  sourceUrl: string;
  explanation: string;
}

const CURRENT_YEAR = new Date().getFullYear();

/**
 * Parse a Swedish number string from allabolag.
 * Allabolag typically shows amounts in KSEK (tkr).
 */
function parseSwedishNumber(raw: string): { value: number; unit: string } | null {
  let s = raw.trim();

  let unit = 'unknown';
  if (/tkr|kkr|tusental/i.test(s)) unit = 'ksek';
  else if (/mkr|msek|miljoner/i.test(s)) unit = 'msek';
  else if (/mdr|mdkr|miljarder/i.test(s)) unit = 'bsek';
  else if (/kr|sek/i.test(s)) unit = 'sek';

  s = s.replace(/[^0-9\s,.\-–−]/g, '').trim();
  if (s.length === 0) return null;

  const isNeg = /^[-–−]/.test(s);
  if (isNeg) s = s.replace(/^[-–−]\s*/, '');

  s = s.replace(/\s+/g, '');
  s = s.replace(',', '.');

  const value = parseFloat(s);
  if (isNaN(value) || !isFinite(value)) return null;

  return { value: isNeg ? -value : value, unit };
}

function toMsek(value: number, unit: string): number {
  switch (unit) {
    case 'ksek': return Math.round(value / 1_000);
    case 'sek': return Math.round(value / 1_000_000);
    case 'bsek': return Math.round(value * 1_000);
    case 'msek': return Math.round(value);
    default: return Math.round(value / 1_000);
  }
}

/**
 * Scrape allabolag.se for a company's basic financial data.
 */
export async function extractFromAllabolag(
  company: CompanyProfile,
): Promise<AllabolagResult | null> {
  if (!company.orgNumber) {
    log.warn(`[${company.name}] No org number — cannot use allabolag fallback`);
    return null;
  }

  const orgClean = company.orgNumber.replace(/-/g, '');
  const baseUrl = `https://www.allabolag.se/${orgClean}`;

  // Fetch multiple allabolag pages — financials may be on sub-pages
  const pagesToTry = [
    baseUrl,
    `${baseUrl}/bokslut`,
    `${baseUrl}/befattningshavare`,
  ];

  let combinedHtml = '';
  const url = baseUrl;

  for (const pageUrl of pagesToTry) {
    log.info(`[${company.name}] Fetching allabolag: ${pageUrl}`);
    const result = await fetchPage(pageUrl, 15_000);
    if (result.ok) {
      combinedHtml += '\n' + result.response.data;
    } else {
      log.debug(`[${company.name}] Allabolag page failed: ${pageUrl} → ${result.error.message}`);
    }
    await sleep(1_000);
  }

  if (combinedHtml.length === 0) {
    log.warn(`[${company.name}] All allabolag pages failed`);
    return null;
  }

  const html = combinedHtml;
  const $ = cheerio.load(html);

  let revenue: number | null = null;
  let ebit: number | null = null;
  let employees: number | null = null;
  let ceo: string | null = null;
  let fiscalYear: number | null = null;

  // --- Strategy 0: JSON-LD structured data ---
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html() || '');
      if (json['@type'] === 'Organization' || json['@type'] === 'Corporation') {
        if (json.numberOfEmployees && employees === null) {
          const empVal = typeof json.numberOfEmployees === 'object'
            ? json.numberOfEmployees.value
            : json.numberOfEmployees;
          if (typeof empVal === 'number' && empVal >= 100) {
            employees = empVal;
            log.debug(`[${company.name}] allabolag employees (JSON-LD): ${employees}`);
          }
        }
      }
    } catch { /* ignore malformed JSON-LD */ }
  });

  // --- Strategy 0b: inline JavaScript data (window.__DATA__, etc.) ---
  $('script:not([src])').each((_, el) => {
    const scriptText = $(el).html() || '';
    // Look for revenue/omsättning values embedded in JS
    const revenueMatch = scriptText.match(/"omsattning"\s*:\s*(\d+)/i) ||
      scriptText.match(/"revenue"\s*:\s*(\d+)/i);
    if (revenueMatch && revenue === null) {
      const val = parseInt(revenueMatch[1], 10);
      if (val >= 1_000) {
        revenue = toMsek(val, 'ksek');
        log.debug(`[${company.name}] allabolag revenue (inline JS): ${revenue} MSEK`);
      }
    }

    const ebitMatch = scriptText.match(/"rorelseresultat"\s*:\s*(-?\d+)/i) ||
      scriptText.match(/"operatingIncome"\s*:\s*(-?\d+)/i);
    if (ebitMatch && ebit === null) {
      const val = parseInt(ebitMatch[1], 10);
      ebit = toMsek(val, 'ksek');
      log.debug(`[${company.name}] allabolag EBIT (inline JS): ${ebit} MSEK`);
    }

    const empMatch = scriptText.match(/"antalAnstallda"\s*:\s*(\d+)/i) ||
      scriptText.match(/"numberOfEmployees"\s*:\s*(\d+)/i);
    if (empMatch && employees === null) {
      const val = parseInt(empMatch[1], 10);
      if (val >= 100 && val < 1_000_000) {
        employees = val;
        log.debug(`[${company.name}] allabolag employees (inline JS): ${employees}`);
      }
    }
  });

  // --- Strategy 1: table-based extraction ---
  // Allabolag often renders financial data in tables or definition lists
  $('table tr, dl').each((_, el) => {
    const rowText = $(el).text().trim();
    const lower = rowText.toLowerCase();

    // Find the numeric value in the element (look for cells/values)
    const cells = $(el).find('td, dd, span, strong').toArray();
    for (const cell of cells) {
      const cellText = $(cell).text().trim();
      if (!/\d{3,}/.test(cellText)) continue; // need at least 3 digits for financial data

      if (revenue === null && /\bomsättning\b|\bnettoomsättning\b/i.test(lower)) {
        const parsed = parseSwedishNumber(cellText);
        if (parsed && Math.abs(parsed.value) >= 100) {
          revenue = toMsek(parsed.value, parsed.unit);
          log.debug(`[${company.name}] allabolag revenue (table): ${revenue} MSEK`);
        }
      }
      if (ebit === null && /\brörelseresultat\b/i.test(lower)) {
        const parsed = parseSwedishNumber(cellText);
        if (parsed && Math.abs(parsed.value) >= 10) {
          ebit = toMsek(parsed.value, parsed.unit);
          log.debug(`[${company.name}] allabolag EBIT (table): ${ebit} MSEK`);
        }
      }
    }

    // Employees — typically a smaller number, no unit suffix
    if (employees === null && /\banställda\b/i.test(lower)) {
      const empMatch = rowText.match(/(\d[\d\s]*\d|\d+)\s*(?:st|personer|anställda)?/i);
      if (empMatch) {
        const empValue = parseInt(empMatch[1].replace(/\s/g, ''), 10);
        if (empValue >= 100 && empValue < 1_000_000) {
          employees = empValue;
          log.debug(`[${company.name}] allabolag employees (table): ${employees}`);
        }
      }
    }
  });

  // --- Strategy 2: structured div/span extraction ---
  // Look for labeled key figures in card-like UI elements
  $('[class*="financial"], [class*="key"], [class*="figure"], [class*="bokslut"], [class*="summary"]').each((_, el) => {
    const text = $(el).text().trim();
    const lower = text.toLowerCase();

    if (revenue === null && /\bomsättning\b/i.test(lower)) {
      const numMatch = text.match(/(\d[\d\s,.]{2,}\d)/);
      if (numMatch) {
        const parsed = parseSwedishNumber(numMatch[1]);
        if (parsed && Math.abs(parsed.value) >= 100) {
          revenue = toMsek(parsed.value, parsed.unit);
          log.debug(`[${company.name}] allabolag revenue (structured): ${revenue} MSEK`);
        }
      }
    }
  });

  // --- Strategy 3: text-based extraction (last resort) ---
  // Parse body text line by line, requiring substantial numbers (4+ digits)
  if (revenue === null || ebit === null || employees === null) {
    const bodyText = $('body').text();
    const lines = bodyText.split(/\n/).map((l) => l.trim()).filter((l) => l.length > 0 && l.length < 300);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lower = line.toLowerCase();

      if (revenue === null && /\bomsättning\b|\bnettoomsättning\b/.test(lower)) {
        const num = findSubstantialNumber(lines, i, 1_000);
        if (num !== null) {
          revenue = num.msek;
          log.debug(`[${company.name}] allabolag revenue (text): ${revenue} MSEK`);
        }
      }

      if (ebit === null && /\brörelseresultat\b/.test(lower)) {
        const num = findSubstantialNumber(lines, i, 10);
        if (num !== null) {
          ebit = num.msek;
          log.debug(`[${company.name}] allabolag EBIT (text): ${ebit} MSEK`);
        }
      }

      if (employees === null && /\banställda\b/.test(lower) && !/genomsnittligt|medel/i.test(lower)) {
        const empMatch = line.match(/(\d[\d\s]+\d|\d{3,})/);
        if (empMatch) {
          const val = parseInt(empMatch[1].replace(/\s/g, ''), 10);
          if (val >= 100 && val < 1_000_000) {
            employees = val;
            log.debug(`[${company.name}] allabolag employees (text): ${employees}`);
          }
        }
      }
    }
  }

  // --- CEO extraction ---
  // Look for VD/Verkställande direktör with a two-step approach:
  // first find the label (case-insensitive), then extract the name (case-sensitive)
  const bodyText = $('body').text();
  const vdPatterns = [
    /verkställande\s+direktör[:\s]+/gi,
    /\bVD[:\s]+/g,
  ];

  for (const pattern of vdPatterns) {
    if (ceo !== null) break;
    let match;
    while ((match = pattern.exec(bodyText)) !== null) {
      const afterLabel = bodyText.substring(match.index + match[0].length);
      // Case-SENSITIVE name match — prevents "LundstedtTelefon" concatenation
      const nameMatch = afterLabel.match(
        /^([A-ZÅÄÖÉÜ][a-zåäöéü]+(?:\s+(?:von\s+|af\s+|de\s+)?[A-ZÅÄÖÉÜ][a-zåäöéü]+){1,3})/,
      );
      if (nameMatch) {
        ceo = nameMatch[1].trim();
        log.debug(`[${company.name}] allabolag CEO: ${ceo}`);
        break;
      }
    }
  }

  // --- Fiscal year ---
  const bokslutsMatch = bodyText.match(/bokslut[:\s]*(\d{4})/i);
  if (bokslutsMatch) {
    const year = parseInt(bokslutsMatch[1], 10);
    if (year >= 2020 && year <= CURRENT_YEAR) {
      fiscalYear = year;
      log.debug(`[${company.name}] allabolag fiscal year: ${fiscalYear}`);
    }
  }

  if (fiscalYear === null) {
    const yearMatches = bodyText.match(/\b(20[12]\d)\b/g);
    if (yearMatches) {
      const years = [...new Set(yearMatches.map(Number))]
        .filter((y) => y >= 2020 && y <= CURRENT_YEAR);
      if (years.length > 0) {
        fiscalYear = Math.max(...years);
        log.debug(`[${company.name}] allabolag fiscal year (inferred): ${fiscalYear}`);
      }
    }
  }

  const fieldsFound = [revenue, ebit, employees, ceo, fiscalYear].filter((f) => f !== null).length;
  if (fieldsFound === 0) {
    log.warn(`[${company.name}] Allabolag page parsed but no usable financial data found`);
    return null;
  }

  log.info(`[${company.name}] Allabolag extraction: ${fieldsFound}/5 fields found`);

  return {
    data: {
      revenue_msek: revenue,
      ebit_msek: ebit,
      employees,
      ceo,
    },
    fiscalYear,
    sourceUrl: url,
    explanation: `PDF not available — data sourced from allabolag.se statutory filings (${url})`,
  };
}

/**
 * Find a substantial number (with at least 4 raw digits) near a label line.
 * Returns the value converted to MSEK, or null.
 */
function findSubstantialNumber(
  lines: string[],
  index: number,
  minAbsValue: number,
): { msek: number } | null {
  for (let offset = 0; offset <= 1 && index + offset < lines.length; offset++) {
    const line = lines[index + offset];
    // Match number sequences with at least 4 digits (ignoring separators)
    const matches = line.match(/[-–−]?\d[\d\s,.]{2,}\d(?:\s*(?:tkr|mkr|mdr|kr))?/gi) ?? [];

    for (const raw of matches) {
      const digits = (raw.match(/\d/g) || []).length;
      if (digits < 4) continue; // Skip tiny numbers — they're not financial data

      const parsed = parseSwedishNumber(raw);
      if (parsed === null) continue;
      if (Math.abs(parsed.value) < minAbsValue) continue;

      return { msek: toMsek(parsed.value, parsed.unit) };
    }
  }

  return null;
}
