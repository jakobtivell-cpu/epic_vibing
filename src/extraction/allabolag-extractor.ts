// ---------------------------------------------------------------------------
// Allabolag.se data extractor — Step 4 (last resort) in the generic fallback chain.
//
// Searches allabolag.se by company NAME (no org number required), then
// scrapes statutory filing data from the company's profile page.
// Confidence is always "low" — these are secondary-source figures.
// ---------------------------------------------------------------------------

import * as cheerio from 'cheerio';
import { ExtractedData } from '../types';
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
 * Search allabolag.se for a company by name and find the company profile URL.
 * @param legalName   Canonical legal entity name from data/ticker.json.
 * @param orgNumber   Swedish org number (e.g. "502032-9081") for direct lookup.
 * @param shortNames  Additional short name variants to try if the primary name fails.
 */
async function findCompanyUrl(
  companyName: string,
  legalName?: string,
  orgNumber?: string,
  shortNames?: string[],
): Promise<string | null> {
  // Priority 1: Direct org number lookup (always works if org number is correct)
  if (orgNumber) {
    const stripped = orgNumber.replace(/[-\s]/g, '');
    const directUrl = `https://www.allabolag.se/${stripped}`;
    log.info(`[${companyName}] Trying allabolag direct org number: ${directUrl}`);

    try {
      const result = await fetchPage(directUrl, 15_000);
      if (result.ok) {
        const baseUrl = directUrl.split('?')[0].replace(/\/$/, '');
        log.info(`[${companyName}] Allabolag org number lookup succeeded: ${baseUrl}`);
        return baseUrl;
      }
    } catch {
      log.debug(`[${companyName}] Allabolag org number lookup failed`);
    }
  }

  // Priority 2: Build search variants — short names first, then legal name, then full name
  const searchTerms: string[] = [];
  if (shortNames) {
    for (const sn of shortNames) {
      if (sn.length >= 2 && sn !== companyName && sn !== legalName) {
        searchTerms.push(sn);
      }
    }
  }
  if (legalName && legalName !== companyName) searchTerms.push(legalName);
  searchTerms.push(companyName);
  if (!/\bAB\b/i.test(companyName)) {
    searchTerms.push(companyName + ' AB');
  }

  // Deduplicate
  const uniqueTerms = [...new Set(searchTerms)];

  const searchVariants = uniqueTerms.map(
    (term) => `https://www.allabolag.se/what/${encodeURIComponent(term)}`,
  );

  const legalLower = legalName?.toLowerCase();

  for (const searchUrl of searchVariants) {
    log.info(`[${companyName}] Searching allabolag: ${searchUrl}`);

    const result = await fetchPage(searchUrl, 15_000);
    if (!result.ok) {
      log.debug(`[${companyName}] Allabolag search failed: ${result.error.message}`);
      continue;
    }

    // Check if the page redirected to a company page directly
    const finalUrl = result.response.finalUrl;
    if (/allabolag\.se\/\d/.test(finalUrl)) {
      const baseUrl = finalUrl.split('?')[0].replace(/\/$/, '');
      log.info(`[${companyName}] Allabolag redirected to company page: ${baseUrl}`);
      return baseUrl;
    }

    const $ = cheerio.load(result.response.data);
    const nameLower = companyName.toLowerCase();
    const candidates: { url: string; score: number }[] = [];

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      const text = $(el).text().trim().toLowerCase();

      if (!/allabolag\.se\/\d/.test(href) && !/^\/\d/.test(href)) return;

      let score = 0;

      // Legal name match — strongest disambiguation signal
      if (legalLower && text.includes(legalLower)) score += 20;
      if (legalLower && text === legalLower) score += 10;

      if (text.includes(nameLower)) score += 10;
      if (text.startsWith(nameLower)) score += 5;
      const words = nameLower.split(/\s+/);
      for (const w of words) {
        if (w.length > 2 && text.includes(w)) score += 2;
      }
      if (text.includes('ab ' + nameLower) || text.includes(nameLower + ' ab')) score += 8;

      // Also score against short names
      if (shortNames) {
        for (const sn of shortNames) {
          const snLower = sn.toLowerCase();
          if (snLower.length >= 2 && text.includes(snLower)) score += 8;
        }
      }

      if (score > 0) {
        const fullUrl = href.startsWith('http') ? href : `https://www.allabolag.se${href.startsWith('/') ? '' : '/'}${href}`;
        candidates.push({ url: fullUrl, score });
      }
    });

    candidates.sort((a, b) => b.score - a.score);

    if (candidates.length > 0) {
      let url = candidates[0].url.split('?')[0].replace(/\/$/, '');
      url = url.replace(/\/(bokslut|befattningshavare|koncern)$/, '');
      log.info(`[${companyName}] Found allabolag company page: ${url} (score: ${candidates[0].score})`);
      return url;
    }
  }

  log.warn(`[${companyName}] No matching company found on allabolag.se`);
  return null;
}

/**
 * Scrape allabolag.se for a company's basic financial data.
 * Searches by company name — no org number required.
 * @param legalName   Optional canonical legal entity name for disambiguation.
 * @param orgNumber   Optional Swedish org number for direct lookup.
 * @param shortNames  Optional short name variants derived from ticker.
 */
export async function extractFromAllabolag(
  companyName: string,
  legalName?: string,
  orgNumber?: string,
  shortNames?: string[],
): Promise<AllabolagResult | null> {
  const baseUrl = await findCompanyUrl(companyName, legalName, orgNumber, shortNames);
  if (!baseUrl) return null;

  const pagesToTry = [
    baseUrl,
    `${baseUrl}/bokslut`,
    `${baseUrl}/befattningshavare`,
  ];

  let combinedHtml = '';

  for (const pageUrl of pagesToTry) {
    log.info(`[${companyName}] Fetching allabolag: ${pageUrl}`);
    const result = await fetchPage(pageUrl, 15_000);
    if (result.ok) {
      combinedHtml += '\n' + result.response.data;
    } else {
      log.debug(`[${companyName}] Allabolag page failed: ${pageUrl} → ${result.error.message}`);
    }
    await sleep(1_000);
  }

  if (combinedHtml.length === 0) {
    log.warn(`[${companyName}] All allabolag pages failed`);
    return null;
  }

  const $ = cheerio.load(combinedHtml);

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
            log.debug(`[${companyName}] allabolag employees (JSON-LD): ${employees}`);
          }
        }
      }
    } catch { /* ignore malformed JSON-LD */ }
  });

  // --- Strategy 0b: inline JavaScript data ---
  $('script:not([src])').each((_, el) => {
    const scriptText = $(el).html() || '';
    const revenueMatch = scriptText.match(/"omsattning"\s*:\s*(\d+)/i) ||
      scriptText.match(/"revenue"\s*:\s*(\d+)/i);
    if (revenueMatch && revenue === null) {
      const val = parseInt(revenueMatch[1], 10);
      if (val >= 1_000) {
        revenue = toMsek(val, 'ksek');
        log.debug(`[${companyName}] allabolag revenue (inline JS): ${revenue} MSEK`);
      }
    }

    const ebitMatch = scriptText.match(/"rorelseresultat"\s*:\s*(-?\d+)/i) ||
      scriptText.match(/"operatingIncome"\s*:\s*(-?\d+)/i);
    if (ebitMatch && ebit === null) {
      const val = parseInt(ebitMatch[1], 10);
      ebit = toMsek(val, 'ksek');
      log.debug(`[${companyName}] allabolag EBIT (inline JS): ${ebit} MSEK`);
    }

    const empMatch = scriptText.match(/"antalAnstallda"\s*:\s*(\d+)/i) ||
      scriptText.match(/"numberOfEmployees"\s*:\s*(\d+)/i);
    if (empMatch && employees === null) {
      const val = parseInt(empMatch[1], 10);
      if (val >= 100 && val < 1_000_000) {
        employees = val;
        log.debug(`[${companyName}] allabolag employees (inline JS): ${employees}`);
      }
    }
  });

  // --- Strategy 1: table-based extraction ---
  $('table tr, dl').each((_, el) => {
    const rowText = $(el).text().trim();
    const lower = rowText.toLowerCase();

    const cells = $(el).find('td, dd, span, strong').toArray();
    for (const cell of cells) {
      const cellText = $(cell).text().trim();
      if (!/\d{3,}/.test(cellText)) continue;

      if (revenue === null && /\bomsättning\b|\bnettoomsättning\b/i.test(lower)) {
        const parsed = parseSwedishNumber(cellText);
        if (parsed && Math.abs(parsed.value) >= 100) {
          revenue = toMsek(parsed.value, parsed.unit);
          log.debug(`[${companyName}] allabolag revenue (table): ${revenue} MSEK`);
        }
      }
      if (ebit === null && /\brörelseresultat\b/i.test(lower)) {
        const parsed = parseSwedishNumber(cellText);
        if (parsed && Math.abs(parsed.value) >= 10) {
          ebit = toMsek(parsed.value, parsed.unit);
          log.debug(`[${companyName}] allabolag EBIT (table): ${ebit} MSEK`);
        }
      }
    }

    if (employees === null && /\banställda\b/i.test(lower)) {
      const empMatch = rowText.match(/(\d[\d\s]*\d|\d+)\s*(?:st|personer|anställda)?/i);
      if (empMatch) {
        const empValue = parseInt(empMatch[1].replace(/\s/g, ''), 10);
        if (empValue >= 100 && empValue < 1_000_000) {
          employees = empValue;
          log.debug(`[${companyName}] allabolag employees (table): ${employees}`);
        }
      }
    }
  });

  // --- Strategy 2: structured div/span extraction ---
  $('[class*="financial"], [class*="key"], [class*="figure"], [class*="bokslut"], [class*="summary"]').each((_, el) => {
    const text = $(el).text().trim();
    const lower = text.toLowerCase();

    if (revenue === null && /\bomsättning\b/i.test(lower)) {
      const numMatch = text.match(/(\d[\d\s,.]{2,}\d)/);
      if (numMatch) {
        const parsed = parseSwedishNumber(numMatch[1]);
        if (parsed && Math.abs(parsed.value) >= 100) {
          revenue = toMsek(parsed.value, parsed.unit);
          log.debug(`[${companyName}] allabolag revenue (structured): ${revenue} MSEK`);
        }
      }
    }
  });

  // --- Strategy 3: text-based extraction (last resort) ---
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
          log.debug(`[${companyName}] allabolag revenue (text): ${revenue} MSEK`);
        }
      }

      if (ebit === null && /\brörelseresultat\b/.test(lower)) {
        const num = findSubstantialNumber(lines, i, 10);
        if (num !== null) {
          ebit = num.msek;
          log.debug(`[${companyName}] allabolag EBIT (text): ${ebit} MSEK`);
        }
      }

      if (employees === null && /\banställda\b/.test(lower) && !/genomsnittligt|medel/i.test(lower)) {
        const empMatch = line.match(/(\d[\d\s]+\d|\d{3,})/);
        if (empMatch) {
          const val = parseInt(empMatch[1].replace(/\s/g, ''), 10);
          if (val >= 100 && val < 1_000_000) {
            employees = val;
            log.debug(`[${companyName}] allabolag employees (text): ${employees}`);
          }
        }
      }
    }
  }

  // --- CEO extraction ---
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
      const nameMatch = afterLabel.match(
        /^([A-ZÅÄÖÉÜ][a-zåäöéü]+(?:\s+(?:von\s+|af\s+|de\s+)?[A-ZÅÄÖÉÜ][a-zåäöéü]+){1,3})/,
      );
      if (nameMatch) {
        ceo = nameMatch[1].trim();
        log.debug(`[${companyName}] allabolag CEO: ${ceo}`);
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
      log.debug(`[${companyName}] allabolag fiscal year: ${fiscalYear}`);
    }
  }

  if (fiscalYear === null) {
    const yearMatches = bodyText.match(/\b(20[12]\d)\b/g);
    if (yearMatches) {
      const years = [...new Set(yearMatches.map(Number))]
        .filter((y) => y >= 2020 && y <= CURRENT_YEAR);
      if (years.length > 0) {
        fiscalYear = Math.max(...years);
        log.debug(`[${companyName}] allabolag fiscal year (inferred): ${fiscalYear}`);
      }
    }
  }

  const fieldsFound = [revenue, ebit, employees, ceo, fiscalYear].filter((f) => f !== null).length;
  if (fieldsFound === 0) {
    log.warn(`[${companyName}] Allabolag page parsed but no usable financial data found`);
    return null;
  }

  log.info(`[${companyName}] Allabolag extraction: ${fieldsFound}/5 fields found`);

  return {
    data: {
      revenue_msek: revenue,
      ebit_msek: ebit,
      employees,
      ceo,
    },
    fiscalYear,
    sourceUrl: baseUrl,
    explanation: `PDF not available — data sourced from allabolag.se statutory filings (${baseUrl})`,
  };
}

function findSubstantialNumber(
  lines: string[],
  index: number,
  minAbsValue: number,
): { msek: number } | null {
  for (let offset = 0; offset <= 1 && index + offset < lines.length; offset++) {
    const line = lines[index + offset];
    const matches = line.match(/[-–−]?\d[\d\s,.]{2,}\d(?:\s*(?:tkr|mkr|mdr|kr))?/gi) ?? [];

    for (const raw of matches) {
      const digits = (raw.match(/\d/g) || []).length;
      if (digits < 4) continue;

      const parsed = parseSwedishNumber(raw);
      if (parsed === null) continue;
      if (Math.abs(parsed.value) < minAbsValue) continue;

      return { msek: toMsek(parsed.value, parsed.unit) };
    }
  }

  return null;
}
