// ---------------------------------------------------------------------------
// Field extraction — parses revenue, EBIT, employees, CEO, and fiscal year
// from raw PDF text using label dictionaries and heuristic number parsing.
//
// Design principle: return null when uncertain — never fabricate a value.
// Every null is accompanied by an explanation in the returned notes array.
// Every non-null carries provenance (matched label, raw snippet, context).
// ---------------------------------------------------------------------------

import { ExtractedData, CompanyType } from '../types';
import type { ReportingModelHint } from '../entity/entity-profile';
import {
  INDUSTRIAL_LABELS,
  BANK_LABELS,
  BANK_REVENUE_LABELS_PRIMARY,
  BANK_EBIT_LABELS_PRIMARY,
  INVESTMENT_LABELS,
  REAL_ESTATE_LABELS,
  REAL_ESTATE_EBIT_LABELS_PRIMARY,
  REAL_ESTATE_REVENUE_LABELS_PRIMARY,
  LabelSet,
} from './labels';
import { createLogger } from '../utils/logger';
import {
  EUR_MILLIONS_TO_MSEK_APPROX,
  USD_MILLIONS_TO_MSEK_APPROX,
} from '../config/settings';
import { parseNumber } from './number-parse';
import { applyRevenueMegascaleMsekGuard, isFusedYearIntegerCorruption } from './number-guards';
import {
  classifyRevenueMapping,
  classifyEbitMapping,
  formatMappingNotes,
} from './schema-mapping';

const log = createLogger('field-extract');

// ---------------------------------------------------------------------------
// Provenance and result types
// ---------------------------------------------------------------------------

export interface FieldProvenance {
  matchedLabel: string;
  rawSnippet: string;
  lineIndex: number;
  context:
    | 'income-statement'
    | 'highlights'
    | 'general'
    | 'segment-fallback'
    | 'ceo-letter'
    | 'management-section';
}

export interface FieldExtractionResult {
  data: ExtractedData;
  fiscalYear: number | null;
  detectedCompanyType: CompanyType;
  provenance: {
    revenue: FieldProvenance | null;
    ebit: FieldProvenance | null;
    employees: FieldProvenance | null;
    ceo: FieldProvenance | null;
  };
  notes: string[];
}

// ---------------------------------------------------------------------------
// Label selection
// ---------------------------------------------------------------------------

function getLabels(companyType: CompanyType): LabelSet {
  switch (companyType) {
    case 'bank':
      return BANK_LABELS;
    case 'investment_company':
      return INVESTMENT_LABELS;
    case 'real_estate':
      return REAL_ESTATE_LABELS;
    default:
      return INDUSTRIAL_LABELS;
  }
}

// ---------------------------------------------------------------------------
// Auto-detect company type from document content
// ---------------------------------------------------------------------------

const BANK_SIGNALS = [
  /\bnet\s+interest\s+income\b/i,
  /\bcredit\s+loss/i,
  /\bkreditförlust/i,
  /\bräntenetto\b/i,
  /\btotal\s+operating\s+income\b/i,
  /\btotala\s+rörelseintäkter\b/i,
  /\bsumma\s+rörelseintäkter\b/i,
  /\blending\b/i,
  /\bdeposits?\s+from\s+(the\s+)?public\b/i,
  /\bcapital\s+adequacy\b/i,
  /\bcommon\s+equity\s+tier\b/i,
  /\bCET1\b/,
];

const INVESTMENT_SIGNALS = [
  /\bnet\s+asset\s+value\b/i,
  /\bNAV\b/,
  /\bportfolio\s+value\b/i,
  /\btotal\s+return\b/i,
  /\bholding\s+compan/i,
  /\binvestmentbolag\b/i,
  /\bsubstansvärde\b/i,
];

const REAL_ESTATE_SIGNALS = [
  /\bförvaltningsresultat\b/i,
  /\bincome\s+from\s+property\s+management\b/i,
  /\bdriftnetto\b/i,
  /\boperating\s+surplus\b/i,
  /\bfair\s+value\s+changes?\b/i,
  /\bvärdeförändring(ar)?\b/i,
];

export function detectCompanyType(text: string): CompanyType {
  const sample = text.substring(0, 30_000).toLowerCase();

  let bankScore = 0;
  for (const p of BANK_SIGNALS) {
    if (p.test(sample)) bankScore++;
  }

  let investScore = 0;
  for (const p of INVESTMENT_SIGNALS) {
    if (p.test(sample)) investScore++;
  }
  let realEstateScore = 0;
  for (const p of REAL_ESTATE_SIGNALS) {
    if (p.test(sample)) realEstateScore++;
  }

  if (investScore >= 3) return 'investment_company';
  if (bankScore >= 2) return 'bank';
  if (realEstateScore >= 2) return 'real_estate';

  return 'industrial';
}

/** Merge legal-name hint with PDF signals — hint wins when explicitly set. */
export function resolveCompanyTypeForExtraction(
  text: string,
  hint?: ReportingModelHint | null,
): CompanyType {
  const detected = detectCompanyType(text);
  if (hint === 'bank') return 'bank';
  if (hint === 'investment_company') return 'investment_company';
  if (hint === 'real_estate') return 'real_estate';
  if (hint === 'industrial') return 'industrial';
  return detected;
}

// ---------------------------------------------------------------------------
// Multi-column table pick — prefer fiscal year column, then last column, EBIT vs revenue
// ---------------------------------------------------------------------------

export interface NumberPickContext {
  preferredFiscalYear: number | null;
  /** Raw PDF-table revenue (same units as EBIT line) for plausibility when picking EBIT among columns. */
  revenueRawHintForEbit: number | null;
}

function parseYearSequenceFromHeaderLine(line: string): number[] {
  const t = line.trim();
  if (t.length > 220) return [];
  // OCR / tight tables: "20242023" on one token (no whitespace between fiscal years).
  if (/^20(1\d|2\d)20(1\d|2\d)$/.test(t)) {
    const y1 = parseInt(t.slice(0, 4), 10);
    const y2 = parseInt(t.slice(4, 8), 10);
    if (y1 >= 2010 && y1 <= 2035 && y2 >= 2010 && y2 <= 2035 && Math.abs(y1 - y2) <= 2) {
      return [y1, y2];
    }
  }
  // Most table headers are columnar (multi-space / tabs), but OCR often collapses
  // them into single spaces (e.g. "SEK K Note 2015 2014"). Keep the strict pass
  // first, then fall back to scanning all year tokens in the line.
  const parts = t.split(/\s{2,}|\t+/).map((p) => p.trim()).filter(Boolean);
  const strictYears: number[] = [];
  for (const p of parts) {
    const m = p.match(/\b(20[12]\d)\b/);
    if (m) strictYears.push(parseInt(m[1], 10));
  }
  if (strictYears.length >= 2) return strictYears;

  const tokenYears = Array.from(t.matchAll(/\b(20[12]\d)\b/g))
    .map((m) => parseInt(m[1], 10))
    .filter((y) => y >= 2010 && y <= 2035);
  return tokenYears.length >= 2 ? tokenYears : [];
}

function yearHeaderLinesAbove(lines: string[], lineIndex: number): string[] {
  const out: string[] = [];
  for (let j = lineIndex - 1; j >= Math.max(0, lineIndex - 3); j--) {
    if (lines[j].length < 300) out.push(lines[j]);
  }
  return out;
}

function selectBestNumericFromCells(
  cells: string[],
  lines: string[],
  lineIndex: number,
  opts: NumberSearchOpts,
  pick: NumberPickContext | undefined,
): { cell: string; value: number } | null {
  const { minValue = -Infinity, maxValue = Infinity } = opts;
  const candidates: { cell: string; value: number; idx: number }[] = [];

  for (let idx = 0; idx < cells.length; idx++) {
    const cell = cells[idx];
    if (isSkippableCell(cell)) continue;
    if (/\d%/.test(cell)) continue;
    const value = parseNumber(cell);
    if (value === null) continue;
    if (value < minValue || value > maxValue) continue;
    candidates.push({ cell, value, idx });
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const absVals = candidates.map((c) => Math.abs(c.value));
  const maxAbs = Math.max(...absVals);
  const minAbs = Math.min(...absVals);
  if (maxAbs / Math.max(minAbs, 1e-6) > 500) {
    return null;
  }

  const lineLower = lines[lineIndex].toLowerCase();
  const groupRow = /\b(group|koncern|consolidated|total(\s+group)?)\b/i.test(lineLower);

  for (const hdr of yearHeaderLinesAbove(lines, lineIndex)) {
    const seq = parseYearSequenceFromHeaderLine(hdr);
    if (seq.length < 2) continue;

    const ordered = [...candidates].sort((a, b) => a.idx - b.idx);
    const tryYearColumn = (year: number): { cell: string; value: number } | null => {
      const yIdx = seq.lastIndexOf(year);
      if (yIdx < 0) return null;
      const col = Math.min(yIdx, ordered.length - 1);
      return ordered[col] ?? null;
    };

    // Prefer the latest fiscal year column in the header (often rightmost current year).
    const latestYear = Math.max(...seq);
    const fromLatest = tryYearColumn(latestYear);
    if (fromLatest) return fromLatest;

    if (pick?.preferredFiscalYear) {
      const fromPreferred = tryYearColumn(pick.preferredFiscalYear);
      if (fromPreferred) return fromPreferred;
    }
  }

  if (pick?.revenueRawHintForEbit != null && Math.abs(pick.revenueRawHintForEbit) > 0) {
    const rev = Math.abs(pick.revenueRawHintForEbit);
    const plausible = candidates.filter((c) => Math.abs(c.value) <= rev * 1.5 + 1);
    if (plausible.length === 1) return plausible[0];
    if (plausible.length > 0) {
      return plausible[plausible.length - 1];
    }
  }

  if (groupRow) {
    const maxVal = Math.max(...candidates.map((c) => c.value));
    const tops = candidates.filter((c) => c.value === maxVal);
    return tops[tops.length - 1];
  }

  return candidates[candidates.length - 1];
}

// ---------------------------------------------------------------------------
// Cell quality filters — reject footnotes, narrative chunks, percentages
// ---------------------------------------------------------------------------

function isFootnoteRef(cell: string): boolean {
  return /^\s*\d{1,2}\s*[)*†*]?\s*$/.test(cell);
}

function isNarrativeCell(cell: string): boolean {
  const digits = (cell.match(/\d/g) || []).length;
  const letters = (cell.match(/[a-zA-ZåäöÅÄÖéÉüÜ]/g) || []).length;
  return letters > digits;
}

function isNoteReference(cell: string): boolean {
  return /^[A-Za-z]{1,2}\d{1,2}$/.test(cell.trim());
}

function isPercentage(cell: string): boolean {
  return cell.includes('%');
}

/**
 * ESEF / PDF tables often emit display years as "2025¹" or "2024)" — treat like a plain
 * year token so column pickers do not select them as numeric data cells.
 */
function normalizedDisplayYearCore(cell: string): string | null {
  const t = cell
    .trim()
    .replace(/[\u00B9\u00B2\u00B3\u2070-\u209F¹²³⁰⁴⁵⁶⁷⁸⁹]+/g, '')
    .replace(/[)\],.;:]+$/g, '')
    .trim();
  if (/^20[12]\d$/.test(t)) return t;
  return null;
}

/** Avoid "fte" matching inside Swedish "löften" / similar fused words. */
function isShortSingleTokenLabelBounded(lineLower: string, labelIdx: number, label: string): boolean {
  if (label.includes(' ') || label.length > 5) return true;
  const letter = /[a-zåäöéüáóíúýæøœ]/;
  const before = labelIdx === 0 ? ' ' : lineLower.charAt(labelIdx - 1);
  const after =
    labelIdx + label.length >= lineLower.length ? ' ' : lineLower.charAt(labelIdx + label.length);
  return !letter.test(before) && !letter.test(after);
}

function isSkippableCell(cell: string): boolean {
  if (normalizedDisplayYearCore(cell)) return true;
  if (/^20[12]\d$/.test(cell.trim())) return true;
  if (isFootnoteRef(cell)) return true;
  if (isNoteReference(cell)) return true;
  if (isNarrativeCell(cell)) return true;
  if (isPercentage(cell)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Unit-context detection — many reports state "amounts in MSEK" once
// ---------------------------------------------------------------------------

type UnitContext = 'msek' | 'bsek' | 'ksek' | 'sek' | 'eur_m' | 'usd_m' | 'usd_k';

function firstMatchIndex(text: string, pattern: RegExp): number {
  const m = text.match(pattern);
  return m?.index ?? Number.POSITIVE_INFINITY;
}

function detectUnitContext(text: string): UnitContext | null {
  const lower = text.toLowerCase();
  // Choose the earliest explicit denomination marker to avoid global-heading bleed
  // in mixed-unit documents (e.g., page heading MSEK but table body KSEK).
  const candidates: Array<{ unit: UnitContext; idx: number }> = [
    {
      unit: 'ksek',
      idx: Math.min(
        firstMatchIndex(lower, /amounts?\s+in\s+ksek\b/),
        firstMatchIndex(lower, /amounts?\s+in\s+sek\s*k\b/),
        firstMatchIndex(lower, /\bksek\b/),
        firstMatchIndex(lower, /\btkr\b/),
      ),
    },
    {
      unit: 'bsek',
      idx: Math.min(
        firstMatchIndex(lower, /amounts?\s+in\s+sek\s*bn\b/),
        firstMatchIndex(lower, /amounts?\s+in\s+bsek\b/),
        firstMatchIndex(lower, /\bmdkr\b/),
        firstMatchIndex(lower, /amounts?\s+in\s+sek\s+billion\b/),
        firstMatchIndex(lower, /\bbillion\s+sek\b/),
        firstMatchIndex(lower, /\bmiljard(er)?\s+sek\b/),
        firstMatchIndex(lower, /\bsek\s*billion\b/),
      ),
    },
    {
      unit: 'msek',
      idx: Math.min(
        firstMatchIndex(lower, /amounts?\s+in\s+sek\s*m\b/),
        firstMatchIndex(lower, /belopp\s+i\s+msek\b/),
        firstMatchIndex(lower, /amounts?\s+in\s+msek\b/),
        firstMatchIndex(lower, /\bmsek\b/),
        firstMatchIndex(lower, /sek\s+millions?\b/),
        firstMatchIndex(lower, /\bmkr\b/),
      ),
    },
    {
      unit: 'eur_m',
      idx: Math.min(
        firstMatchIndex(lower, /amounts?\s+in\s+(?:million\s+)?euros?\b/),
        firstMatchIndex(lower, /\bin\s+eur\s*m\b/),
        firstMatchIndex(lower, /\bmeur\b/),
        firstMatchIndex(lower, /\b€\s*m\b/),
        firstMatchIndex(lower, /\beur\s*million\b/),
        firstMatchIndex(lower, /\bmillion\s+euros?\b/),
        firstMatchIndex(lower, /\belopp\s+i\s+meur\b/),
        firstMatchIndex(lower, /\bi\s+miljoner\s+euro\b/),
      ),
    },
    {
      unit: 'usd_k',
      idx: Math.min(
        firstMatchIndex(lower, /\(in\s+thousands\s+of\s+u\.?s\.?\s*dollars/),
        firstMatchIndex(lower, /amounts?\s+in\s+thousands?\s+of\s+(?:u\.?s\.?\s*)?dollars?\b/),
        firstMatchIndex(lower, /amounts?\s+in\s+000s?\s+of\s+(?:u\.?s\.?\s*)?dollars?\b/),
        firstMatchIndex(lower, /\bthousands?\s+of\s+(?:u\.?s\.?\s*)?dollars?\b/),
        firstMatchIndex(lower, /\b000s?\s+of\s+u\.?s\.?\s*dollars?\b/),
      ),
    },
    {
      unit: 'usd_m',
      idx: Math.min(
        firstMatchIndex(
          lower,
          /amounts?\s+(?:expressed|stated|presented)\s+in\s+millions?\s+of\s+(?:united\s+states\s+)?dollars?\b/,
        ),
        firstMatchIndex(lower, /amounts?\s+in\s+millions?\s+of\s+(?:u\.?s\.?\s*)?dollars?\b/),
        firstMatchIndex(lower, /\bin\s+millions?\s+of\s+(?:u\.?s\.?\s*)?dollars?\b/),
        firstMatchIndex(lower, /\bu\.?s\.?\s*dollars?\s+in\s+millions?\b/),
        firstMatchIndex(lower, /\busd\s*(?:million|millions|m)\b/),
        firstMatchIndex(lower, /\bus\$\s*(?:million|millions|m)\b/),
        firstMatchIndex(lower, /\bu\.?s\.?\s*\$\s*(?:million|millions|m)\b/),
        firstMatchIndex(lower, /\bmillion\s+u\.?s\.?\s*dollars?\b/),
      ),
    },
  ];

  const best = candidates
    .filter((c) => Number.isFinite(c.idx))
    .sort((a, b) => a.idx - b.idx)[0];

  return best?.unit ?? null;
}

/** Parsed BSEK-style revenue from narrative / infographic text (not tables). */
interface NarrativeBsekHit {
  msek: number;
  matchedLabel: string;
  rawSnippet: string;
}

interface NarrativeEmployeeHit {
  employees: number;
  matchedLabel: string;
  rawSnippet: string;
}


function isPlausibleBsekBillions(val: number): boolean {
  return !isNaN(val) && val >= 1 && val <= 2_000;
}

function isPlausibleNarrativeEmployees(val: number): boolean {
  return Number.isFinite(val) && val >= 50 && val <= 700_000;
}

const NARRATIVE_REVENUE_BAD_CONTEXT =
  /since\s+\d{4}|by\s+20\d{2}|over\s+the\s+(past|last)|cumulative|divested|spun\s+off|acquired|combined|target|ambition|goal|increase\b.*\bto\b/i;

/**
 * Scan full text for total revenue stated in SEK billions: classic BSEK phrases,
 * and Sales / Net sales infographic labels ("Sales, SEK billion" + value on same
 * or next line). Returns MSEK. Sales-style patterns are tried first.
 */
function findNarrativeBsekRevenueHit(text: string): NarrativeBsekHit | null {
  type Pat = { re: RegExp; label: string };
  const salesPatterns: Pat[] = [
    {
      re: /\bsales\s*,\s*SEK\s+billion[^\d]{0,50}(\d[\d.,]*)/gi,
      label: 'Sales, SEK billion',
    },
    {
      re: /\bnet\s+sales\s*,\s*SEK\s+billion[^\d]{0,50}(\d[\d.,]*)/gi,
      label: 'Net sales, SEK billion',
    },
    {
      re: /\bsales\s*,\s*SEK\s+billion\s*[\r\n]+\s*(\d[\d.,]*)/gim,
      label: 'Sales, SEK billion',
    },
    {
      re: /\bnet\s+sales\s*,\s*SEK\s+billion\s*[\r\n]+\s*(\d[\d.,]*)/gim,
      label: 'Net sales, SEK billion',
    },
    {
      re: /\bsales\s+SEK\s+billion[^\d]{0,50}(\d[\d.,]*)/gi,
      label: 'Sales SEK billion',
    },
  ];

  const genericPatterns: Pat[] = [
    { re: /(?:group|total|the group)\s+had\s+revenues?\s+of\s+BSEK\s*(\d[\d.,]*)/gi, label: 'revenues of BSEK' },
    { re: /revenues?\s+(?:amounted|totaled|totalled)\s+to\s+BSEK\s*(\d[\d.,]*)/gi, label: 'revenues to BSEK' },
    { re: /revenues?\s+of\s+BSEK\s*(\d[\d.,]*)/gi, label: 'revenues of BSEK' },
    { re: /revenues?\s+of\s+SEK\s*(\d[\d.,]*)\s*billion/gi, label: 'revenues of SEK … billion' },
    { re: /had\s+revenues?\s+of\s+BSEK\s*(\d[\d.,]*)/gi, label: 'had revenues of BSEK' },
    {
      re: /\bsales\s+(?:amounted|were|was|totalled|totaled)\s+to\s+SEK\s*(\d[\d.,]*)\s*billion/gi,
      label: 'sales … SEK … billion',
    },
    {
      re: /\bnet\s+sales\s+(?:amounted|were|was)\s+SEK\s*(\d[\d.,]*)\s*billion/gi,
      label: 'net sales … SEK … billion',
    },
  ];

  // Some annual reports summarize consolidated revenue in MSEK-style narrative,
  // e.g. "Net sales amounted to SEK 20,427m", which is a strong fallback when
  // table OCR collapses multi-year columns.
  const msekNarrativePatterns: Pat[] = [
    {
      re: /\bnet\s+sales\s+amounted\s+to\s+SEK\s*(\d{1,3}(?:,\d{3})+)\s*m\b/gi,
      label: 'net sales … SEK … m',
    },
    {
      re: /\brevenue\s+amounted\s+to\s+SEK\s*(\d{1,3}(?:,\d{3})+)\s*m\b/gi,
      label: 'revenue … SEK … m',
    },
  ];

  const tryPatterns = (patterns: Pat[]): NarrativeBsekHit | null => {
    for (const { re, label } of patterns) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(text)) !== null) {
        const contextStart = Math.max(0, match.index - 80);
        const ctx = text.substring(contextStart, match.index + match[0].length + 40);
        if (NARRATIVE_REVENUE_BAD_CONTEXT.test(ctx)) continue;

        const raw = match[1].replace(/,/g, '');
        const val = parseFloat(raw);
        if (isPlausibleBsekBillions(val)) {
          return {
            msek: Math.round(val * 1_000),
            matchedLabel: label,
            rawSnippet: match[0].trim().substring(0, 160),
          };
        }
      }
    }
    return null;
  };
  const tryMsekPatterns = (patterns: Pat[]): NarrativeBsekHit | null => {
    for (const { re, label } of patterns) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(text)) !== null) {
        const contextStart = Math.max(0, match.index - 80);
        const ctx = text.substring(contextStart, match.index + match[0].length + 40);
        if (NARRATIVE_REVENUE_BAD_CONTEXT.test(ctx)) continue;

        const raw = match[1].replace(/,/g, '');
        const val = parseFloat(raw);
        if (!isNaN(val) && isFinite(val) && val >= 1_000 && val <= 5_000_000) {
          return {
            msek: Math.round(val),
            matchedLabel: label,
            rawSnippet: match[0].trim().substring(0, 160),
          };
        }
      }
    }
    return null;
  };

  return tryPatterns(salesPatterns) ?? tryPatterns(genericPatterns) ?? tryMsekPatterns(msekNarrativePatterns);
}

function findNarrativeEmployeeHit(text: string): NarrativeEmployeeHit | null {
  type Pat = { re: RegExp; label: string };
  const patterns: Pat[] = [
    {
      re: /\bon\s+average,\s+the\s+group\s+had\s+(\d{2,3}(?:,\d{3})*|\d{2,6})(?:\s*\([\d,\s]{2,12}\))?\s+employees\b/gi,
      label: 'on average, the group had ... employees',
    },
    {
      re: /\bthe\s+group\s+had\s+(\d{2,3}(?:,\d{3})*|\d{2,6})(?:\s*\([\d,\s]{2,12}\))?\s+employees\b/gi,
      label: 'the group had ... employees',
    },
    {
      re: /\baverage\s+number\s+of\s+employees(?:\s+was|\s+were|\s*[:=])?\s*(\d{2,3}(?:,\d{3})*|\d{2,6})\b/gi,
      label: 'average number of employees',
    },
  ];

  for (const { re, label } of patterns) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      const raw = match[1].replace(/,/g, '');
      const val = parseInt(raw, 10);
      if (!isPlausibleNarrativeEmployees(val)) continue;
      return {
        employees: val,
        matchedLabel: label,
        rawSnippet: match[0].trim().substring(0, 180),
      };
    }
  }
  return null;
}


function normalizeToMsek(value: number, unit: UnitContext | null): number {
  switch (unit) {
    case 'bsek':
      return value * 1_000;
    case 'ksek':
      return value / 1_000;
    case 'sek':
      return value / 1_000_000;
    case 'eur_m':
      return Math.round(value * EUR_MILLIONS_TO_MSEK_APPROX);
    case 'usd_m':
      return Math.round(value * USD_MILLIONS_TO_MSEK_APPROX);
    case 'usd_k':
      // IFRS-style tables: figures in thousands of USD → convert via USD millions × SEK/USD.
      return Math.round((value / 1000) * USD_MILLIONS_TO_MSEK_APPROX);
    case 'msek':
    default:
      return value;
  }
}

function applyEbitMegascaleGuard(
  ebit: number,
  revenue: number | null,
): { ebit: number; adjusted: boolean } {
  if (!Number.isFinite(ebit)) return { ebit, adjusted: false };
  const candidate = Math.round(ebit / 1_000);
  if (revenue === null) {
    if (Math.abs(ebit) >= 1_000_000) return { ebit: candidate, adjusted: true };
    return { ebit, adjusted: false };
  }
  if (Math.abs(ebit) >= 1_000_000 && Math.abs(candidate) <= Math.abs(revenue) * 2 + 1) {
    return { ebit: candidate, adjusted: true };
  }
  // Common OCR/unit issue: KSEK two-year table values collapse into a single huge
  // MSEK-looking number (e.g. "481 414" parsed as 481414). When this dominates
  // revenue by a wide margin but ÷1000 lands in a plausible EBIT range, correct it.
  if (
    Math.abs(ebit) >= 100_000 &&
    Math.abs(ebit) > Math.abs(revenue) * 8 + 1 &&
    Math.abs(candidate) <= Math.abs(revenue) * 2 + 1
  ) {
    return { ebit: candidate, adjusted: true };
  }
  return { ebit, adjusted: false };
}

function hasFusedYearRawArtifact(rawCell: string): boolean {
  const compact = rawCell.replace(/[^\d]/g, '');
  return /(20\d{2}){2,}/.test(compact);
}

/**
 * Detect unit context within a specific line range (e.g., an income
 * statement section). Falls back to the global context if no local
 * indicator is found. This prevents a global "BSEK" indicator from
 * being applied to a section that declares "Amounts in SEK m".
 */
/**
 * When the global/section unit is USD thousands (IFRS tables) but the matched line is
 * clearly stated in USD millions (MD&A narrative), use millions scaling for that row.
 */
function resolveUsdAmountUnitForLine(
  lines: string[],
  lineIndex: number,
  sectionUnit: UnitContext | null,
): UnitContext | null {
  if (sectionUnit !== 'usd_k' && sectionUnit !== 'usd_m') return sectionUnit;
  const window = lines
    .slice(Math.max(0, lineIndex - 1), Math.min(lines.length, lineIndex + 2))
    .join(' ')
    .toLowerCase();
  if (
    /\$\s*[\d][\d,]*(?:\.\d+)?\s+million\b/.test(window) ||
    /\b\d[\d,]*(?:\.\d+)?\s+million\s+(?:u\.?s\.?\s*)?dollars?\b/.test(window)
  ) {
    return 'usd_m';
  }
  return sectionUnit;
}

function detectSectionUnitContext(
  lines: string[],
  start: number,
  end: number,
  globalUnit: UnitContext | null,
): UnitContext | null {
  const windowEnd = Math.min(end, start + 6);
  for (let i = Math.max(0, start - 3); i <= windowEnd; i++) {
    const line = lines[i];
    if (!line) continue;
    const combinedNext = `${line} ${lines[i + 1] ?? ''}`;
    const combinedPrev = `${lines[i - 1] ?? ''} ${line}`;
    const lineUnit =
      detectUnitContext(line) ?? detectUnitContext(combinedNext) ?? detectUnitContext(combinedPrev);
    if (lineUnit) {
      if (lineUnit !== globalUnit) {
        log.debug(
          `Section-level unit override: ${lineUnit} (global was ${globalUnit}) at line ${i}`,
        );
      }
      return lineUnit;
    }
  }
  return globalUnit;
}

// ---------------------------------------------------------------------------
// EBIT exclusion guards — reject EBITDA, adjusted variants, PBT, margin
// ---------------------------------------------------------------------------

const EBIT_EXCLUSIONS: RegExp[] = [
  /\bebitda\b/i,
  /\badjusted\s+(operating\s+)?(profit|income|ebit|result)/i,
  /\bcomparable\s+operating\s+(profit|income|result)/i,
  /\bunderlying\s+operating\s+(profit|income|result)/i,
  /\bresultat\s+före\s+skatt\b/i,
  /\bprofit\s+before\s+tax\b/i,
  /\boperating\s+margin\b/i,
  /\brörelsemarginal\b/i,
  /\bjusterad\b/i,
  /\badjusted\b/i,
  /\bjämförelsestörande\b/i,
  /\bitems\s+affecting\s+comparability\b/i,
  /\bexkl\.\s/i,
  /\bexcluding\s/i,
  /\bförvaltningsresultat\b/i,
  /\bincome\s+from\s+property\s+management\b/i,
  /\bdriftnetto\b/i,
  /\boperating\s+surplus\b/i,
  // Narrative sensitivity commentary (e.g. FX/one-offs) often says
  // "impact on operating profit of SEK X" — this is not the EBIT line item.
  /\bimpact\s+on\s+operating\s+profit\b/i,
  /\bpåverkan\s+på\s+rörelseresultat\b/i,
];

/** Exclusions for adjusted-EBIT pass — still block EBITDA / PBT, but allow adjusted / underlying labels. */
const EBIT_EXCLUSIONS_ADJUSTED_PASS: RegExp[] = [
  /\bebitda\b/i,
  /\bresultat\s+före\s+skatt\b/i,
  /\bprofit\s+before\s+tax\b/i,
];

/** Bank pass allows profit-before-tax proxy labels (with explicit note when used). */
const EBIT_EXCLUSIONS_BANK: RegExp[] = [
  /\bebitda\b/i,
  /\boperating\s+margin\b/i,
  /\brörelsemarginal\b/i,
];

const ADJUSTED_EBIT_LABELS: string[] = [
  'adjusted operating profit',
  'adjusted operating income',
  'ebit ex. items affecting comparability',
  'ebit före jämförelsestörande poster',
  'justerat rörelseresultat',
  'underlying operating profit',
  'adjusted ebit',
  'kärnresultat',
];

const OPERATING_MARGIN_LABEL_PATTERNS: RegExp[] = [
  /\badjusted\s+operating\s+margin\b/i,
  /\bebita[-\s]?marginal\b/i,
  /\boperating\s+margin\b/i,
  /\brörelsemarginal\b/i,
  /\bjusterad\s+rörelsemarginal\b/i,
  /\bebit\s+margin\b/i,
  /\brörelseresultat\s+i\s*%\b/i,
];

const TELECOM_SIGNALS = /\btelecom\b|\barpu\b|\bsubscriber(s)?\b|\bmobile\b|\boperator\b/i;

const SEGMENT_EBIT_BEFORE_FIN_RE =
  /\brörelseresultat\s+före\s+finansiella(?:\s+poster)?\b|\boperating\s+profit\s+before\s+financial\s+items?\b/i;

const AMORT_INTANGIBLE_LINE_RES: RegExp[] = [
  /\bamortization\s+of\s+intangible\s+assets\b/i,
  /\bamortisation\s+of\s+intangible\s+assets\b/i,
  /\bavskrivningar\s+på\s+immateriella\s+tillgångar\b/i,
  /\bavskrivning\s+på\s+immateriella\b/i,
];

// ---------------------------------------------------------------------------
// Labeled-number finder — section-aware with consolidated statement priority
// ---------------------------------------------------------------------------

interface NumberSearchOpts {
  minValue?: number;
  maxValue?: number;
  exclusions?: RegExp[];
}

/** Wider rows / offsets help bank PDFs where tables flow into long single lines. */
interface ScanConstraints {
  table: { maxLineLen: number; maxLabelOffset: number };
  loose: { maxLineLen: number; maxLabelOffset: number };
}

const SCAN_DEFAULT: ScanConstraints = {
  table: { maxLineLen: 150, maxLabelOffset: 60 },
  loose: { maxLineLen: 500, maxLabelOffset: 200 },
};

const SCAN_BANK: ScanConstraints = {
  table: { maxLineLen: 300, maxLabelOffset: 140 },
  loose: { maxLineLen: 900, maxLabelOffset: 360 },
};

/** Internal match record with provenance data. */
interface NumberMatch {
  value: number;
  lineIndex: number;
  label: string;
  rawCell: string;
  context: string;
  /** Line range of the section this match came from (for unit detection). */
  sectionRange?: { start: number; end: number };
}

/** Patterns that identify the start of a consolidated income statement section. */
const INCOME_STATEMENT_PATTERNS: RegExp[] = [
  /consolidated\s+(?:statement\s+of\s+)?(?:income|profit|loss)/i,
  /consolidated\s+statements?\s+of\s+(?:\(?(?:loss|profit|income)\)?\s+)?earnings/i,
  /consolidated\s+income\s+statement/i,
  /(?:income|profit\s+(?:and|&)\s+loss)\s+statement/i,
  /koncernens\s+resultaträkning/i,
  /resultaträkning/i,
  /statement\s+of\s+(?:profit|income|loss)/i,
];

/** Patterns that indicate a section boundary (end of income statement section). */
const SECTION_BOUNDARY_PATTERNS: RegExp[] = [
  /consolidated\s+(?:statement\s+of\s+)?(?:financial\s+position|balance\s+sheet|comprehensive\s+income|cash\s+flow|changes\s+in\s+equity)/i,
  /balance\s+sheet/i,
  /koncernens\s+balansräkning/i,
  /balansräkning/i,
  /kassaflödesanalys/i,
  /statement\s+of\s+(?:cash\s+flows?|financial\s+position|changes\s+in\s+equity)/i,
  /notes\s+to\s+the\s+(?:consolidated\s+)?financial\s+statements/i,
];

/** Patterns for segment breakdown sections — results here should be deprioritized. */
const SEGMENT_PATTERNS: RegExp[] = [
  /segment\s+(?:information|reporting|overview|results?)/i,
  /(?:operating|business|reportable)\s+segments?/i,
  /segmentöversikt/i,
  /segmentinformation/i,
  /business\s+areas?\s+(?:overview|results?|performance)/i,
];

/** Patterns for highlights / key figures sections near the front of the report. */
const HIGHLIGHTS_PATTERNS: RegExp[] = [
  /\bat\s+a\s+glance\b/i,
  /\bhighlights\b/i,
  /\bi\s+korthet\b/i,
  /\bnyckeltal\b/i,
  /\bkey\s+figures?\b/i,
  /\bfinancial\s+summary\b/i,
  /\bfinansöversikt\b/i,
];

/**
 * True when the income-statement heading line is clearly parent-only (moderbolag / parent
 * company), not consolidated — so we can skip it when a koncern/consolidated section exists.
 */
function incomeHeadingIsParentCompanyOnly(line: string): boolean {
  if (/koncernens\s+och\s+moderbolaget|(?:the\s+)?group\s+and\s+(?:the\s+)?parent|consolidated\s+and\s+(?:parent|separate)/i.test(line)) {
    return false;
  }
  if (/koncern(?:ens)?|consolidated|konsoliderad/i.test(line)) {
    return false;
  }
  return /moderbolag|parent\s+compan|för\s+moderbolaget|the\s+parent\s+compan|parent\s+company/i.test(
    line,
  );
}

function findIncomeStatementSections(lines: string[]): Array<{ start: number; end: number }> {
  const raw: Array<{ start: number; end: number; parentOnly: boolean }> = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 120) continue;
    const isHeading = INCOME_STATEMENT_PATTERNS.some((p) => {
      const m = lines[i].match(p);
      if (!m || (m.index ?? 0) >= 15) return false;
      const afterMatch = lines[i].substring((m.index ?? 0) + m[0].length).trim();
      return afterMatch.length < 10 || /^\d{1,3}$/.test(afterMatch);
    });
    if (!isHeading) continue;

    let end = Math.min(i + 80, lines.length);
    for (let j = i + 1; j < end; j++) {
      if (lines[j].length > 120) continue;
      const isBoundary = SECTION_BOUNDARY_PATTERNS.some((p) => p.test(lines[j]));
      if (isBoundary) {
        end = j;
        break;
      }
    }

    if (end - i >= 5) {
      raw.push({ start: i, end, parentOnly: incomeHeadingIsParentCompanyOnly(lines[i]) });
    }
  }

  const nonParent = raw.filter((s) => !s.parentOnly);
  const picked = nonParent.length > 0 ? nonParent : raw;
  return picked.map(({ start, end }) => ({ start, end }));
}

/**
 * Find sections of text that look like highlights / key-figures pages.
 * Returns line ranges [start, start+30) for each detected heading.
 */
function findHighlightsSections(lines: string[]): Array<{ start: number; end: number }> {
  const sections: Array<{ start: number; end: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 80) continue;
    if (!HIGHLIGHTS_PATTERNS.some((p) => p.test(lines[i]))) continue;

    const end = Math.min(i + 30, lines.length);
    sections.push({ start: i, end });
  }

  return sections;
}

function isInSegmentSection(lineIndex: number, lines: string[]): boolean {
  for (let i = lineIndex; i >= Math.max(0, lineIndex - 40); i--) {
    if (lines[i].length > 120) continue;
    if (SEGMENT_PATTERNS.some((p) => p.test(lines[i]))) return true;
    if (INCOME_STATEMENT_PATTERNS.some((p) => p.test(lines[i]))) return false;
  }
  return false;
}

/** Segment "rörelseresultat före finansiella …" title row that borrows the next line — not consolidated EBIT. */
function isGhostSegmentEbitHeaderMatch(m: NumberMatch, lines: string[]): boolean {
  const line = lines[m.lineIndex];
  return (
    SEGMENT_EBIT_BEFORE_FIN_RE.test(line) &&
    extractNumberTokens(line).length === 0 &&
    isInSegmentSection(m.lineIndex, lines)
  );
}

/**
 * Find a labeled number within a set of lines. Two-pass: strict table-like rows
 * first, then any reasonable line.
 */
function findLabeledNumber(
  lines: string[],
  labels: string[],
  opts: NumberSearchOpts = {},
  pickContext?: NumberPickContext,
  scan: ScanConstraints = SCAN_DEFAULT,
): NumberMatch | null {
  const tableResult = scanForNumber(lines, labels, opts, scan.table, pickContext);
  if (tableResult !== null) return tableResult;

  return scanForNumber(lines, labels, opts, scan.loose, pickContext);
}

/**
 * Section-aware number finder with provenance tracking.
 * Search order: income statement → highlights → general (skip segments) → segment fallback.
 */
function findFinancialNumber(
  lines: string[],
  labels: string[],
  opts: NumberSearchOpts = {},
  pick?: NumberPickContext,
  scan: ScanConstraints = SCAN_DEFAULT,
): NumberMatch | null {
  const isSections = findIncomeStatementSections(lines);

  // Priority pass 1: income statement sections
  if (isSections.length > 0) {
    for (const section of isSections) {
      const sectionLines = lines.slice(section.start, section.end);
      const result = findLabeledNumber(sectionLines, labels, opts, pick, scan);
      if (result !== null) {
        result.lineIndex += section.start;
        if (isGhostSegmentEbitHeaderMatch(result, lines)) {
          log.debug(
            `Skipping ghost segment EBIT header row at line ${result.lineIndex} inside income-statement window`,
          );
          continue;
        }
        result.context = 'income-statement';
        result.sectionRange = section;
        log.debug(
          `Found value ${result.value} within income statement section (lines ${section.start}-${section.end})`,
        );
        return result;
      }
    }
  }

  // Priority pass 2: highlights / key figures sections
  const highlightSections = findHighlightsSections(lines);
  if (highlightSections.length > 0) {
    for (const section of highlightSections) {
      const sectionLines = lines.slice(section.start, section.end);
      const result = findLabeledNumber(sectionLines, labels, opts, pick, scan);
      if (result !== null) {
        result.lineIndex += section.start;
        result.context = 'highlights';
        result.sectionRange = section;
        log.debug(
          `Found value ${result.value} in highlights section (lines ${section.start}-${section.end})`,
        );
        return result;
      }
    }
  }

  // Fallback: general search, but skip matches inside segment sections
  const allMatches = findAllLabeledNumbers(
    lines,
    labels,
    opts,
    pick,
    scan.loose.maxLineLen,
    scan.loose.maxLabelOffset,
  );
  const nonSegmentMatch = allMatches.find((m) => !isInSegmentSection(m.lineIndex, lines));
  if (nonSegmentMatch) {
    nonSegmentMatch.context = 'general';
    log.debug(
      `Found value ${nonSegmentMatch.value} outside segment section (line ${nonSegmentMatch.lineIndex})`,
    );
    return nonSegmentMatch;
  }

  // Last resort: return any match (even from segment sections), but not a segment
  // "rörelseresultat före finansiella …" header row that only borrows the next line's number
  // (handled explicitly by extractEbitFromSegmentResultsBeforeFinancial).
  const fallbackPool = allMatches.filter(
    (m) => !isGhostSegmentEbitHeaderMatch(m, lines) && !isInSegmentSection(m.lineIndex, lines),
  );
  if (fallbackPool.length > 0) {
    fallbackPool[0].context = 'segment-fallback';
    log.debug(
      `Using segment-section value ${fallbackPool[0].value} as last resort (line ${fallbackPool[0].lineIndex})`,
    );
    return fallbackPool[0];
  }

  return null;
}

/** Try bank-specific (or other primary) labels first, then the full merged list. */
function findFinancialNumberPhased(
  lines: string[],
  primaryLabels: string[],
  allLabels: string[],
  opts: NumberSearchOpts,
  pick: NumberPickContext | undefined,
  scan: ScanConstraints,
): NumberMatch | null {
  const primary = findFinancialNumber(lines, primaryLabels, opts, pick, scan);
  if (primary !== null) return primary;
  return findFinancialNumber(lines, allLabels, opts, pick, scan);
}

/**
 * Strip note references fused to the start of afterLabel text.
 * Handles both alphanumeric (e.g. "C31") and pure numeric (e.g. "31") note refs
 * when they are fused directly to subsequent number tokens.
 */
function stripLeadingNoteRef(text: string): string {
  // Pattern 1: alpha-prefixed note refs with space separator (safe, unambiguous)
  // e.g. "C31 168,343" or "G2, G3 122,878"
  const alphaSpaced = text.match(/^(?:[A-Z]{1,2}\d{1,2}(?:,\s*[A-Z]{1,2}\d{1,2})*\s+)/);
  if (alphaSpaced) {
    return text.substring(alphaSpaced[0].length);
  }

  // Pattern 2: single alpha note ref fused with comma-grouped number
  // e.g. "C31168,343" → strip "C31" to get "168,343"
  const alphaFused = text.match(/^([A-Z]{1,2}\d)(\d{1,3}(?:,\d{3})+)/);
  if (alphaFused) {
    return text.substring(alphaFused[1].length);
  }

  // Pattern 3: multi alpha note refs fused with comma-grouped number
  // e.g. "G2, G3122,878120,680" → strip "G2, G3" to get "122,878120,680"
  const multiAlpha = text.match(/^([A-Z]{1,2}\d{1,2}(?:,\s*[A-Z]{1,2}\d{1,2})*,\s*[A-Z]{1,2})(\d)(\d{1,3}(?:,\d{3})+)/);
  if (multiAlpha) {
    const noteLen = multiAlpha[1].length + multiAlpha[2].length;
    return text.substring(noteLen);
  }

  return text;
}

/**
 * Split text into table cells. Handles both multi-space separated and
 * ESEF-style columns where spaces serve as thousand separators.
 *
 * For ESEF PDFs, "168 343176 771" should produce ["168 343", "176 771"]
 * by reassembling space-separated digit groups into thousand-grouped numbers.
 */
function splitIntoCells(text: string): string[] {
  const stdCells = text.split(/\s{2,}|\t+/).map((c) => c.trim()).filter(Boolean);
  if (stdCells.length >= 2) {
    // Tabular rows sometimes fuse a note ref with the first USD column, e.g.
    // "(Note 19)$ 3,422,604" + "$ 2,743,444" after whitespace normalization — split on
    // each "$ …" monetary column so multi-year pickers see one number per cell.
    const expanded: string[] = [];
    for (const c of stdCells) {
      const fuseNoteOrMultiUsd =
        /\)\s*\$\s*[-–−]?[\d]/i.test(c) || (c.match(/\$/g) ?? []).length >= 2;
      if (!fuseNoteOrMultiUsd) {
        expanded.push(c);
        continue;
      }
      const chunks = c
        .split(/(?=\$\s*[-–−]?[\d][\d,\s]*)/)
        .map((x) => x.trim())
        .filter(Boolean);
      if (chunks.length > 1) expanded.push(...chunks);
      else expanded.push(c);
    }
    return expanded.filter(Boolean);
  }

  // Attempt ESEF-style reassembly: greedily combine digit groups
  // that form valid thousand-separated numbers (e.g. "168 343" → 168343).
  const tokens = text.trim().split(/\s+/);
  if (tokens.length < 2 || !tokens.every((t) => /^[-–−]?\d+$/.test(t))) {
    return stdCells;
  }

  const result: string[] = [];
  let current = tokens[0];

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.length === 3 && /^\d{3}$/.test(tok)) {
      current += ' ' + tok;
    } else {
      result.push(current);
      current = tok;
    }
  }
  result.push(current);
  return result.length >= 2 ? result : stdCells;
}

/**
 * Find ALL occurrences of labeled numbers (not just the first).
 * Used by findFinancialNumber to filter by section context.
 */
function findAllLabeledNumbers(
  lines: string[],
  labels: string[],
  opts: NumberSearchOpts = {},
  pickContext?: NumberPickContext,
  maxLineLen = 150,
  maxLabelOffset = 60,
): NumberMatch[] {
  const results: NumberMatch[] = [];
  const { minValue = -Infinity, maxValue = Infinity, exclusions } = opts;

  for (const label of labels) {
    const labelLower = label.toLowerCase();

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > maxLineLen) continue;
      const lineLower = lines[i].toLowerCase();
      const labelIdx = lineLower.indexOf(labelLower);
      if (labelIdx < 0 || labelIdx > maxLabelOffset) continue;

      if (labelLower === 'ebit' && lineLower.charAt(labelIdx + label.length) === 'a') {
        continue;
      }

      if (!isShortSingleTokenLabelBounded(lineLower, labelIdx, labelLower)) continue;

      if (labelIdx >= 6) {
        const before = lineLower.substring(Math.max(0, labelIdx - 6), labelIdx).trim();
        if (/\bother$/.test(before)) continue;
      }

      if (exclusions && exclusions.some((ex) => ex.test(lineLower))) continue;

      let afterLabel = lines[i].substring(labelIdx + label.length);
      afterLabel = afterLabel.replace(/^[)}\]]+/, '');
      afterLabel = stripLeadingNoteRef(afterLabel);

      const chosen = pickNumberFromLabelTail(afterLabel, lines, i, opts, pickContext);
      if (chosen !== null) {
        results.push({
          value: chosen.value,
          lineIndex: i,
          label,
          rawCell: chosen.cell,
          context: 'general',
        });
      }
    }
  }

  return results;
}

/** When the first employee hit is implausibly low vs revenue, try another labeled row. */
function pickBetterEmployeeMatchForRevenue(
  matches: NumberMatch[],
  currentEmployees: number,
  revenueMsek: number,
): NumberMatch | null {
  const minOk = Math.max(100, Math.floor(revenueMsek / 50));
  if (currentEmployees >= minOk) return null;
  const candidates = matches.filter((m) => {
    const e = Math.round(m.value);
    return e >= minOk && e <= 700_000 && e !== currentEmployees;
  });
  if (candidates.length === 0) return null;
  const target = revenueMsek / 25;
  return candidates.reduce((a, b) =>
    Math.abs(Math.round(a.value) - target) <= Math.abs(Math.round(b.value) - target) ? a : b,
  );
}

/**
 * Extract individual number tokens from text that may lack proper whitespace.
 */
function extractNumberTokens(text: string): string[] {
  const tokens: string[] = [];
  // Require hard token boundaries so we do not pick synthetic middle values from
  // OCR-collapsed decimal sequences such as "253.1256.7210.5" (where "1256.7"
  // is not a real column value, but a glue artifact between 253.1 and 256.7).
  const numberRe =
    /(?<![\d.])[-–−]?(?:\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{4,}(?:\.\d{1,2})?)(?![\d.])/g;
  let m;
  while ((m = numberRe.exec(text)) !== null) {
    tokens.push(m[0]);
  }
  return tokens;
}

/**
 * Prefer numbers on the label row; only merge the following line when the tail has no usable figure
 * (avoids pulling segment / subtotal rows into the same cell set as Intäkter / Net sales).
 */
function pickNumberFromLabelTail(
  afterLabel: string,
  lines: string[],
  lineIndex: number,
  opts: NumberSearchOpts,
  pickContext?: NumberPickContext,
): { cell: string; value: number } | null {
  const { minValue = -Infinity, maxValue = Infinity } = opts;
  const tail = afterLabel.trim();

  const gluedPairCells = extractGluedPairThousandCells(tail);
  if (gluedPairCells.length >= 2) {
    const gluedPick = selectBestNumericFromCells(
      gluedPairCells,
      lines,
      lineIndex,
      opts,
      pickContext,
    );
    if (gluedPick !== null) return gluedPick;
  }

  const fusedFourDigitCells = extractFusedFourDigitPairCells(tail);
  if (fusedFourDigitCells.length >= 2) {
    const fusedPick = selectBestNumericFromCells(
      fusedFourDigitCells,
      lines,
      lineIndex,
      opts,
      pickContext,
    );
    if (fusedPick !== null) return fusedPick;
  }

  const fusedThreeDigitCells = extractFusedThreeDigitPairCells(tail);
  if (fusedThreeDigitCells.length >= 2) {
    const fusedPick = selectBestNumericFromCells(
      fusedThreeDigitCells,
      lines,
      lineIndex,
      opts,
      pickContext,
    );
    if (fusedPick !== null) return fusedPick;
  }

  let chosen = selectBestNumericFromCells(splitIntoCells(tail), lines, lineIndex, opts, pickContext);
  if (chosen !== null && /\d\s+\d/.test(chosen.cell) && (chosen.cell.match(/\s+/g) ?? []).length >= 2) {
    const reconstructed = selectBestNumericFromCells(
      reconstructCompactColumnCells(tail, lines, lineIndex),
      lines,
      lineIndex,
      opts,
      pickContext,
    );
    if (reconstructed !== null) {
      chosen = reconstructed;
    }
  }
  if (chosen !== null) return chosen;

  // Some OCR/ESEF rows collapse multiple year columns into a single space-group
  // stream (e.g. "215 016 215 240"). Reconstruct likely per-column numbers.
  chosen = selectBestNumericFromCells(
    reconstructCompactColumnCells(tail, lines, lineIndex),
    lines,
    lineIndex,
    opts,
    pickContext,
  );
  if (chosen !== null) return chosen;

  const directTokens = extractNumberTokens(afterLabel);
  for (const token of directTokens) {
    if (normalizedDisplayYearCore(token)) continue;
    if (/^20[12]\d$/.test(token)) continue;
    const value = parseNumber(token);
    if (value === null) continue;
    if (value < minValue || value > maxValue) continue;
    return { cell: token, value };
  }

  const fyPick = pickContext?.preferredFiscalYear ?? null;
  const isMisreadYearValue = (val: number): boolean => {
    const v = Math.round(val);
    if (!Number.isFinite(v) || v < 1900 || v > 2100) return false;
    if (fyPick == null) return false;
    return v === fyPick || v === fyPick - 1 || v === fyPick + 1;
  };

  /** Swedish / English consolidated rows: "Moderbolaget1504915449" → first 3-digit column. */
  const tryParentCompanyFusedHeadcount = (mergedBody: string): { cell: string; value: number } | null => {
    const hit = mergedBody.match(/(?:moderbolaget|parent\s+company)\D*/i);
    if (!hit || hit.index === undefined) return null;
    const rest = mergedBody.slice(hit.index + hit[0].length).trim();
    let m = rest.match(/^(\d{3})(?=\d{6,})/);
    if (!m) m = rest.match(/^(\d{3,5})(?=\s|[,]|$)/);
    if (!m) return null;
    const value = parseNumber(m[1]);
    if (value === null || value < minValue || value > maxValue) return null;
    if (isMisreadYearValue(value)) return null;
    return { cell: m[1], value };
  };

  if (lineIndex + 1 < lines.length) {
    if (!tail) {
      const buf: string[] = [];
      for (let j = 1; j <= 12 && lineIndex + j < lines.length; j++) {
        const seg = lines[lineIndex + j].trim();
        if (!seg) continue;
        if (/^[\)\],.:;–\-]+$/.test(seg)) continue;
        if (normalizedDisplayYearCore(seg)) continue;
        buf.push(seg);
        const mergedBody = buf.join('  ').trim();
        if (!mergedBody) continue;

        chosen = selectBestNumericFromCells(
          splitIntoCells(mergedBody),
          lines,
          lineIndex,
          opts,
          pickContext,
        );
        if (chosen !== null && !isMisreadYearValue(chosen.value)) {
          return chosen;
        }

        const parentPick = tryParentCompanyFusedHeadcount(mergedBody);
        if (parentPick !== null) return parentPick;
      }
    } else {
      const merged = `${afterLabel}  ${lines[lineIndex + 1]}`;
      chosen = selectBestNumericFromCells(
        splitIntoCells(merged.trim()),
        lines,
        lineIndex,
        opts,
        pickContext,
      );
      if (chosen !== null) return chosen;
    }
  }

  return null;
}

function extractGluedPairThousandCells(tail: string): string[] {
  const t = tail.replace(/\u00A0/g, ' ').replace(/[.,]/g, ' ');
  const m = t.match(/([-–−]?\d{1,3}\s+\d{3})\s*([-–−]?\d{1,3}\s+\d{3})/);
  if (!m) return [];
  const a = m[1].replace(/\s+/g, ' ').trim();
  const b = m[2].replace(/\s+/g, ' ').trim();
  if (!/\d/.test(a) || !/\d/.test(b)) return [];
  return [a, b];
}

/**
 * Handles OCR-fused two-year 4-digit cells like "13791 278" where intended
 * values are "1379" and "1278".
 */
function extractFusedFourDigitPairCells(tail: string): string[] {
  const t = tail.replace(/\u00A0/g, ' ').replace(/[−–]/g, '-').trim();
  const m = t.match(/^(-?)(\d{5})\s+(\d{3})(?!\d)/);
  if (!m) return [];
  const sign = m[1];
  const first5 = m[2];
  const trailing3 = m[3];
  const a = `${sign}${first5.slice(0, 4)}`;
  const b = `${sign}${first5.slice(4)}${trailing3}`;
  if (!/^-?\d{4}$/.test(a) || !/^-?\d{4}$/.test(b)) return [];
  return [a, b];
}

/**
 * Handles OCR-fused two-year 3-digit cells like "579708" where intended
 * values are "579" and "708".
 */
function extractFusedThreeDigitPairCells(tail: string): string[] {
  const t = tail.replace(/\u00A0/g, ' ').replace(/[−–]/g, '-').trim();
  const m = t.match(/^(-?)(\d{6})(?!\d)/);
  if (!m) return [];
  const sign = m[1];
  const six = m[2];
  const trailing = six.slice(3);
  // Avoid splitting a likely genuine thousand value like "100000".
  if (/^0{3}$/.test(trailing)) return [];
  const a = `${sign}${six.slice(0, 3)}`;
  const b = `${sign}${trailing}`;
  if (!/^-?\d{3}$/.test(a) || !/^-?\d{3}$/.test(b)) return [];
  return [a, b];
}

function reconstructCompactColumnCells(
  tail: string,
  lines: string[],
  lineIndex: number,
): string[] {
  const normalized = tail
    .replace(/[,\u00A0]/g, ' ')
    .replace(/[^\d\s\-–−]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/^\s*[-–−]?\d{1,4}(?:\s+\d{1,4}){3,}\s*$/.test(normalized)) return [];

  const groups = normalized.match(/\d{1,4}/g);
  if (!groups || groups.length < 4) return [];

  let expectedCols: number | null = null;
  for (const hdr of yearHeaderLinesAbove(lines, lineIndex)) {
    const seq = parseYearSequenceFromHeaderLine(hdr);
    if (seq.length >= 2) {
      expectedCols = seq.length;
      break;
    }
  }

  const out: string[] = [];
  if (expectedCols && expectedCols >= 2 && expectedCols <= 4) {
    const groupsPerCol = Math.floor(groups.length / expectedCols);
    if (groupsPerCol >= 1 && groupsPerCol <= 3) {
      for (let c = 0; c < expectedCols; c++) {
        const from = c * groupsPerCol;
        const to = from + groupsPerCol;
        if (to <= groups.length) out.push(groups.slice(from, to).join(' '));
      }
      if (out.length >= 2) return out;
    }
  }

  // Fallback: pairwise thousand-group chunks for 2-column tables.
  for (let i = 0; i + 1 < groups.length; i += 2) {
    out.push(`${groups[i]} ${groups[i + 1]}`);
  }
  return out;
}

function scanForNumber(
  lines: string[],
  labels: string[],
  opts: NumberSearchOpts,
  constraints: { maxLineLen: number; maxLabelOffset: number },
  pickContext?: NumberPickContext,
): NumberMatch | null {
  const { minValue = -Infinity, maxValue = Infinity, exclusions } = opts;

  for (const label of labels) {
    const labelLower = label.toLowerCase();

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > constraints.maxLineLen) continue;

      const lineLower = lines[i].toLowerCase();
      const labelIdx = lineLower.indexOf(labelLower);
      if (labelIdx < 0) continue;
      if (labelIdx > constraints.maxLabelOffset) continue;

      if (labelLower === 'ebit' && lineLower.charAt(labelIdx + label.length) === 'a') {
        continue;
      }

      if (!isShortSingleTokenLabelBounded(lineLower, labelIdx, labelLower)) continue;

      if (labelIdx >= 6) {
        const before = lineLower.substring(Math.max(0, labelIdx - 6), labelIdx).trim();
        if (/\bother$/.test(before)) continue;
      }

      if (exclusions && exclusions.some((ex) => ex.test(lineLower))) continue;

      let afterLabel = lines[i].substring(labelIdx + label.length);
      afterLabel = afterLabel.replace(/^[)}\]]+/, '');
      afterLabel = stripLeadingNoteRef(afterLabel);

      const chosen = pickNumberFromLabelTail(afterLabel, lines, i, opts, pickContext);
      if (chosen !== null) {
        log.debug(`Found "${label}": ${chosen.value} (raw: "${chosen.cell}")`);
        return {
          value: chosen.value,
          lineIndex: i,
          label,
          rawCell: chosen.cell,
          context: 'general',
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// CEO name extraction — checks before, on, and after the label line
// ---------------------------------------------------------------------------

const NON_NAME_PATTERNS = [
  'top management',
  'group management',
  'management team',
  'board of directors',
  'executive team',
  'executive committee',
  'senior leadership',
  'group functions',
  'corporate governance',
  'annual report',
  'sustainability report',
  'financial statements',
  'income statement',
  'table of contents',
  'chairman',
  'the board',
  'supervisory board',
  'ordförande',
  'chief financial officer',
  'cfo',
  'auditor',
  'revisor',
  'board member',
  'styrelseledamot',
  'single electronic format',
  'electronic format',
  'esef report',
  'managing partner',
  'internal audit',
];

const CORPORATE_WORDS = /\b(?:group|board|committee|team|communications|holding|capital|partners|investment|management|report|statement|corporate|governance|foundation|business|area|president|director|officer|vice|senior|division|segment|unit|meeting|annual|general)\b/i;

const TITLE_ONLY_RE = /^the\s+\w+$/i;

// Two-letter words that are never first or last names
const NON_NAME_WORDS = /^(?:we|do|an|if|or|so|at|by|in|on|to|up|is|it|no)$/i;
const COMMON_NON_NAMES = /\b(?:things|about|with|from|that|this|what|where|which|their|these|those|have|been|will|would|could|should|does)\b/i;

function isKnownNonName(text: string): boolean {
  const lower = text.toLowerCase();
  if (NON_NAME_PATTERNS.some((p) => lower === p || lower.startsWith(p))) return true;
  if (CORPORATE_WORDS.test(text)) return true;
  if (TITLE_ONLY_RE.test(text.trim())) return true;
  if (COMMON_NON_NAMES.test(text)) return true;
  const words = text.trim().split(/\s+/);
  if (words.some((w) => NON_NAME_WORDS.test(w))) return true;
  return false;
}

/** Also reject lines that contain a role title suggesting someone other than the CEO. */
function lineContainsNonCeoRole(line: string): boolean {
  const lower = line.toLowerCase();
  return (
    /\bchairman\b/i.test(lower) ||
    /\bordförande\b/i.test(lower) ||
    /\bchief\s+financial\s+officer\b/i.test(lower) ||
    /\b(?:^|[^a-z])cfo(?:[^a-z]|$)/i.test(lower) ||
    /\bauditor\b/i.test(lower) ||
    /\brevisor\b/i.test(lower)
  );
}

const NAME_RE =
  /([A-ZÅÄÖÉÜ][a-zåäöéü]+(?:[\s-]+(?:von\s+|af\s+|de\s+)?[A-ZÅÄÖÉÜ][a-zåäöéü]+){1,3})/;

/** Internal result from CEO search with provenance. */
interface CeoMatch {
  name: string;
  label: string;
  lineIndex: number;
  pattern: string;
  context: 'ceo-letter' | 'management-section' | 'general';
}

/**
 * Search for CEO name with a priority window. First scans the CEO letter
 * (first ~120 lines), then the full document.
 */
function findCeoWithProvenance(lines: string[], labels: string[]): CeoMatch | null {
  // Pass 1: CEO letter window — scan first ~800 lines to cover the
  // CEO letter section which may appear on pages 5-20 in large reports.
  const ceoLetterEnd = Math.min(800, lines.length);
  const letterResult = scanForCeo(lines, labels, 0, ceoLetterEnd);
  if (letterResult) {
    letterResult.context = 'ceo-letter';
    return letterResult;
  }

  // Pass 2: Management / board section (look for section headings)
  const mgmtSections = findManagementSections(lines);
  for (const section of mgmtSections) {
    const result = scanForCeo(lines, labels, section.start, section.end);
    if (result) {
      result.context = 'management-section';
      return result;
    }
  }

  // No full-document scan — too many false positives.
  // Prefer null over a wrong guess.
  return null;
}

const MANAGEMENT_SECTION_PATTERNS: RegExp[] = [
  /\b(?:group\s+)?management\b/i,
  /\bkoncernledning\b/i,
  /\bstyrelse\b/i,
  /\bboard\s+of\s+directors\b/i,
  /\bleadership\b/i,
];

function findManagementSections(lines: string[]): Array<{ start: number; end: number }> {
  const sections: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 80) continue;
    if (!MANAGEMENT_SECTION_PATTERNS.some((p) => p.test(lines[i]))) continue;
    sections.push({ start: Math.max(0, i - 2), end: Math.min(i + 40, lines.length) });
  }
  return sections;
}

function isAgmOrVotingContext(block: string): boolean {
  const l = block.toLowerCase();
  return (
    /\bagm\b/.test(l) ||
    /annual\s+general\s+meeting/.test(l) ||
    /extraordinary\s+general/.test(l) ||
    /bolagsstämma|bolagsstamma/.test(l) ||
    /\bkallelse\b/.test(l) ||
    /postal\s+vote|postal\s+voting/.test(l) ||
    /\bröstmaterial\b/.test(l) ||
    /notice\s+of\s+(?:the\s+)?(?:annual|general)\s+meeting/.test(l) ||
    /valberedningens\s+förslag/.test(l)
  );
}

function isNominationElectionContext(block: string): boolean {
  const l = block.toLowerCase();
  return (
    /\bproposal\b/.test(l) ||
    /\bnomination\s+committee\b/.test(l) ||
    /\belection\s+of\b/.test(l) ||
    /\bvalberedning\b/.test(l) ||
    /\bförslag\s+till\s+styrelsen\b/.test(l)
  );
}

function lineDescribesFormerOrOtherCeo(line: string, labelIdx: number): boolean {
  const before = line.substring(0, labelIdx).toLowerCase();
  if (/\bformer\b/.test(before)) return true;
  if (/\btidigare\b/.test(before)) return true;
  if (/\bex[\s-]/.test(before)) return true;
  if (/\bfd\.?\b/.test(before)) return true;
  if (/\bwhich\b/.test(before)) return true;

  const after = line.substring(labelIdx).toLowerCase();
  if (/\bceo\s+(?:of|at|för)\s+/i.test(after)) return true;
  if (/\bvd\s+(?:of|at|för|på)\s+/i.test(after)) return true;

  const full = line.toLowerCase();
  if (/company\s+of\s+which\b.*\bceo\b/.test(full)) return true;
  if (/shareholder.*\bceo\b/.test(full)) return true;

  return false;
}

function scanForCeo(
  lines: string[],
  labels: string[],
  startLine: number,
  endLine: number,
): CeoMatch | null {
  for (const label of labels) {
    const labelLower = label.toLowerCase();

    for (let i = startLine; i < endLine; i++) {
      const lineLower = lines[i].toLowerCase();
      const idx = lineLower.indexOf(labelLower);
      if (idx < 0) continue;

      const ctxLo = Math.max(0, i - 2);
      const ctxHi = Math.min(lines.length, i + 2);
      const contextBlock = lines.slice(ctxLo, ctxHi).join(' ');
      if (isAgmOrVotingContext(contextBlock) || isNominationElectionContext(contextBlock)) {
        log.debug(`Skipping CEO in AGM/nomination context: "${lines[i].trim().substring(0, 90)}"`);
        continue;
      }

      if (lineContainsNonCeoRole(lines[i]) && !/\bceo\b/i.test(lines[i]) && !/\bvd\b/i.test(lines[i])) {
        continue;
      }

      if (lineDescribesFormerOrOtherCeo(lines[i], idx)) {
        log.debug(`Skipping former/other-company CEO line: "${lines[i].trim().substring(0, 100)}"`);
        continue;
      }

      // Pattern A: name on the PREVIOUS line (signature-style)
      if (i > startLine) {
        const prevLine = lines[i - 1].trim();
        const prevMatch = prevLine.match(
          /^([A-ZÅÄÖÉÜ][a-zåäöéü]+(?:[\s-]+(?:von\s+|af\s+|de\s+)?[A-ZÅÄÖÉÜ][a-zåäöéü]+){1,3})$/,
        );
        if (prevMatch && !isKnownNonName(prevMatch[1])) {
          log.debug(`Found CEO (prev line): "${prevMatch[1]}" via "${label}"`);
          return { name: prevMatch[1], label, lineIndex: i - 1, pattern: 'prev-line', context: 'general' };
        }
      }

      // Pattern B: name AFTER the label on the same line
      const afterLabel = lines[i]
        .substring(idx + label.length)
        .replace(/^[:\s–—,.-]+/, '')
        .trim();

      const afterMatch = afterLabel.match(NAME_RE);
      if (afterMatch && !isKnownNonName(afterMatch[1])) {
        log.debug(`Found CEO (same line): "${afterMatch[1]}" via "${label}"`);
        return { name: afterMatch[1], label, lineIndex: i, pattern: 'same-line-after', context: 'general' };
      }

      // Pattern C: name BEFORE the label on the same line
      const beforeLabel = lines[i].substring(0, idx).replace(/[,:\s–—.-]+$/, '').trim();
      const beforeMatch = beforeLabel.match(NAME_RE);
      if (beforeMatch && !isKnownNonName(beforeMatch[1])) {
        log.debug(`Found CEO (before label): "${beforeMatch[1]}" via "${label}"`);
        return { name: beforeMatch[1], label, lineIndex: i, pattern: 'same-line-before', context: 'general' };
      }

      // Pattern D: name on the NEXT line
      if (i + 1 < endLine) {
        const nextLine = lines[i + 1].trim();
        const nextMatch = nextLine.match(NAME_RE);
        if (nextMatch && !isKnownNonName(nextMatch[1])) {
          log.debug(`Found CEO (next line): "${nextMatch[1]}" via "${label}"`);
          return { name: nextMatch[1], label, lineIndex: i + 1, pattern: 'next-line', context: 'general' };
        }
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Fiscal year extraction
// ---------------------------------------------------------------------------

function findFiscalYear(
  text: string,
  fallbackYear: number | null,
): number | null {
  const patterns = [
    /annual\s+report\s+(\d{4})/i,
    /årsredovisning\s+(\d{4})/i,
    /fiscal\s+year\s+(\d{4})/i,
    /räkenskapsår(?:et)?\s+(\d{4})/i,
    /financial\s+year\s+(\d{4})/i,
    /for\s+the\s+year\s+ended.*?(\d{4})/i,
    /january\s*[-–]\s*december\s+(\d{4})/i,
    /januari\s*[-–]\s*december\s+(\d{4})/i,
  ];

  // Restrict to first ~3000 chars (title page / report header) to avoid
  // matching forward-looking statements like "Financial year 2027 targets".
  const frontMatter = text.substring(0, 3_000);

  for (const pattern of patterns) {
    const match = frontMatter.match(pattern);
    if (match) {
      const year = parseInt(match[1], 10);
      if (year >= 2020 && year <= 2030) {
        log.debug(`Fiscal year from text (front matter): ${year} (${pattern.source})`);
        return year;
      }
    }
  }

  // Broaden to first ~15000 chars (approximately first 10 pages) if front
  // matter didn't have it — some reports bury the year deeper.
  const earlyText = text.substring(0, 15_000);
  for (const pattern of patterns) {
    const match = earlyText.match(pattern);
    if (match) {
      const year = parseInt(match[1], 10);
      if (year >= 2020 && year <= 2030) {
        log.debug(`Fiscal year from text (early pages): ${year} (${pattern.source})`);
        return year;
      }
    }
  }

  if (fallbackYear !== null) {
    log.debug(`Using fallback fiscal year from discovery: ${fallbackYear}`);
    return fallbackYear;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Provenance builder helper
// ---------------------------------------------------------------------------

function numMatchToProvenance(m: NumberMatch): FieldProvenance {
  return {
    matchedLabel: m.label,
    rawSnippet: m.rawCell,
    lineIndex: m.lineIndex,
    context: m.context as FieldProvenance['context'],
  };
}

function isRevenueHighConfidenceForMarginDerivation(
  revenue: number | null,
  revProv: FieldProvenance | null,
): boolean {
  if (revenue === null || revProv === null) return false;
  const ml = revProv.matchedLabel.toLowerCase();
  if (ml.includes('allabolag')) return false;
  if (
    /sales,?\s+sek billion|net sales,?\s+sek billion|sales sek billion|revenues?\s+of\s+bsek|revenues?\s+to\s+bsek|had\s+revenues?\s+of\s+bsek|narrative/i.test(
      ml,
    )
  ) {
    return false;
  }
  return true;
}

function parsePercentageFromLineAfterLabel(line: string, labelEndIdx: number): number | null {
  const tail = line.substring(Math.max(0, labelEndIdx));
  const m = tail.match(/(\d{1,2}(?:[.,]\d+)?)\s*%/);
  if (!m) return null;
  const rawPct = m[1].replace(',', '.');
  const p = parseFloat(rawPct);
  if (!Number.isFinite(p)) return null;
  return p;
}

/**
 * Priority 3 — operating margin (or EBIT margin) × revenue_msek.
 */
function extractEbitFromOperatingMarginTimesRevenue(
  lines: string[],
  revenueMsek: number,
  revProv: FieldProvenance | null,
): NumberMatch | null {
  if (!isRevenueHighConfidenceForMarginDerivation(revenueMsek, revProv)) return null;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 220) continue;
    const line = lines[i];
    const lineLower = line.toLowerCase();
    let matchedPattern = '';
    let labelEnd = -1;
    for (const pat of OPERATING_MARGIN_LABEL_PATTERNS) {
      const m = line.match(pat);
      if (m && m.index !== undefined) {
        matchedPattern = m[0];
        labelEnd = m.index + m[0].length;
        break;
      }
    }
    if (labelEnd < 0) continue;

    if (/\bebitda\b/i.test(lineLower)) continue;

    const pct = parsePercentageFromLineAfterLabel(line, labelEnd);
    if (pct === null) continue;
    if (pct < -80 || pct > 80) continue;

    const ebitMsek = Math.round((revenueMsek * pct) / 100);
    if (!Number.isFinite(ebitMsek) || ebitMsek === 0) continue;

    return {
      value: ebitMsek,
      lineIndex: i,
      label: matchedPattern.trim(),
      rawCell: `${pct}% × revenue`,
      context: 'general',
    };
  }
  return null;
}

interface EbitaDeriveResult {
  match: NumberMatch;
  proxyWithoutAmort: boolean;
}

/**
 * EBITA strategy: subtract amortization of intangibles within ±15 lines when found;
 * otherwise use EBITA as EBIT proxy (documented in notes).
 */
function extractEbitFromEbitaMinusAmortization(
  lines: string[],
  opts: NumberSearchOpts,
  pick: NumberPickContext | undefined,
  scan: ScanConstraints,
): EbitaDeriveResult | null {
  const { minValue = -Infinity, maxValue = Infinity } = opts;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > scan.loose.maxLineLen) continue;
    const lineLower = lines[i].toLowerCase();
    if (/\bebitda\b/.test(lineLower)) continue;
    const idx = lineLower.search(/\bebita\b/);
    if (idx < 0 || idx > scan.loose.maxLabelOffset + 20) continue;

    let afterLabel = lines[i].substring(idx + 'ebita'.length);
    afterLabel = afterLabel.replace(/^[)}\]]+/, '');
    afterLabel = stripLeadingNoteRef(afterLabel);
    // Do not append the next line — amortization often follows and pollutes cell picking.
    const cells = splitIntoCells(afterLabel.trim());
    const chosen = selectBestNumericFromCells(cells, lines, i, opts, pick);
    if (chosen === null) continue;
    const ebitaVal = chosen.value;
    if (ebitaVal < minValue || ebitaVal > maxValue) continue;

    let amortVal: number | null = null;
    let amortLine = -1;
    for (
      let j = Math.max(0, i - 15);
      j <= Math.min(lines.length - 1, i + 15);
      j++
    ) {
      if (j === i) continue;
      const L = lines[j];
      let amortMatch: RegExpMatchArray | null = null;
      for (const re of AMORT_INTANGIBLE_LINE_RES) {
        const mm = L.match(re);
        if (mm) {
          amortMatch = mm;
          break;
        }
      }
      if (!amortMatch || amortMatch.index === undefined) continue;
      const after = L.substring(amortMatch.index + amortMatch[0].length);
      const c2 = extractNumberTokens(after);
      for (const tok of c2) {
        const v = parseNumber(tok);
        if (v !== null && Math.abs(v) > 0 && Math.abs(v) < Math.abs(ebitaVal) * 2) {
          amortVal = v;
          amortLine = j;
          break;
        }
      }
      if (amortVal !== null) break;
      const cells2 = splitIntoCells(after.replace(/^[:\s–—,.-]+/, ''));
      const ch2 = selectBestNumericFromCells(cells2, lines, j, { minValue: 0, maxValue: Math.abs(ebitaVal) }, pick);
      if (ch2 !== null) {
        amortVal = ch2.value;
        amortLine = j;
        break;
      }
    }

    if (amortVal === null) {
      return {
        match: {
          value: ebitaVal,
          lineIndex: i,
          label: 'EBITA',
          rawCell: String(chosen.cell),
          context: 'general',
        },
        proxyWithoutAmort: true,
      };
    }

    const ebitRaw = ebitaVal - Math.abs(amortVal);
    if (ebitRaw < minValue || ebitRaw > maxValue) continue;

    return {
      match: {
        value: ebitRaw,
        lineIndex: i,
        label: 'EBITA − amortization intangibles',
        rawCell: `EBITA ${ebitaVal}; amort ${amortVal} (line ${amortLine})`,
        context: 'segment-fallback',
      },
      proxyWithoutAmort: false,
    };
  }
  return null;
}

function parseSegmentTableNumericLine(
  line: string,
  opts: NumberSearchOpts,
): number | null {
  const { minValue = -Infinity, maxValue = Infinity } = opts;
  const ll = line.toLowerCase();
  if (/\btotal\b|\bsumma\b|\belimination/.test(ll)) return null;
  const tokens = extractNumberTokens(line);
  for (let t = tokens.length - 1; t >= 0; t--) {
    const v = parseNumber(tokens[t]);
    if (v !== null && v >= minValue && v <= maxValue) return v;
  }
  return null;
}

/**
 * Priority 5 — sum segment operating results where the block is explicitly before financial items.
 */
function extractEbitFromSegmentResultsBeforeFinancial(
  lines: string[],
  opts: NumberSearchOpts,
  unitContext: UnitContext | null,
): NumberMatch | null {
  const { minValue = -Infinity, maxValue = Infinity } = opts;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 200) continue;
    if (!SEGMENT_EBIT_BEFORE_FIN_RE.test(lines[i])) continue;
    if (!isInSegmentSection(i, lines)) continue;

    const headerNums = extractNumberTokens(lines[i]);
    let sum = 0;
    let count = 0;
    let headerLineIdx = i;

    if (headerNums.length > 0) {
      const lastTok = headerNums[headerNums.length - 1];
      const hv = parseNumber(lastTok);
      if (hv !== null && hv >= minValue && hv <= maxValue) {
        sum = hv;
        count = 1;
        headerLineIdx = i;
      }
    }

    const maxJ = Math.min(lines.length - 1, i + 22);
    for (let j = i + 1; j <= maxJ; j++) {
      const L = lines[j];
      if (L.length === 0) {
        if (count >= 2) break;
        continue;
      }
      if (L.length > 180) continue;
      if (
        L.length < 120 &&
        INCOME_STATEMENT_PATTERNS.some((p) => {
          const mm = L.match(p);
          if (!mm || (mm.index ?? 0) >= 15) return false;
          const afterMatch = L.substring((mm.index ?? 0) + mm[0].length).trim();
          return afterMatch.length < 10 || /^\d{1,3}$/.test(afterMatch);
        })
      ) {
        break;
      }
      if (SECTION_BOUNDARY_PATTERNS.some((p) => p.test(L)) && count >= 1) break;
      if (SEGMENT_EBIT_BEFORE_FIN_RE.test(L) && j > i + 1) break;
      const v = parseSegmentTableNumericLine(L, opts);
      if (v === null) continue;
      sum += v;
      count++;
    }

    if (count < 2) continue;
    const unit = detectSectionUnitContext(lines, Math.max(0, i - 3), maxJ, unitContext);
    const msek = Math.round(normalizeToMsek(sum, unit));
    if (!Number.isFinite(msek) || msek === 0) continue;

    return {
      value: sum,
      lineIndex: headerLineIdx,
      label: 'segment sum (before financial items)',
      rawCell: String(sum),
      context: 'segment-fallback',
      sectionRange: { start: Math.max(0, i - 2), end: maxJ + 1 },
    };
  }
  return null;
}

function normalizeEbitMatchToMsek(
  m: NumberMatch,
  lines: string[],
  unitContext: UnitContext | null,
): number {
  const ebitUnit = m.sectionRange
    ? detectSectionUnitContext(
        lines,
        m.sectionRange.start,
        m.sectionRange.end,
        unitContext,
      )
    : detectSectionUnitContext(
        lines,
        Math.max(0, m.lineIndex - 2),
        Math.min(lines.length - 1, m.lineIndex + 2),
        unitContext,
      );
  return Math.round(normalizeToMsek(m.value, ebitUnit));
}

const BANK_PBT_PROXY_LABEL = 'result before tax';
const REAL_ESTATE_VALUE_CHANGE_RE =
  /\bvärdeförändring(ar)?\b|\bunreali[sz]ed\s+gains?\b|\bfair\s+value\s+changes?\b/i;
const INVESTMENT_PORTFOLIO_RE =
  /\bportfolio\b|\bnet\s+asset\s+value\b|\bnav\b|\bfair\s+value\b|\bsubstansvärde\b/i;
const INVESTMENT_OPERATING_SECTION_RE =
  /\bindustrial\b|\boperations?\b|\brörelse(n|r)?\b/i;

function extractInvestmentOperatingEbit(
  lines: string[],
  opts: NumberSearchOpts,
  pick: NumberPickContext,
): { match: NumberMatch | null; discardedPortfolioTotal: boolean } {
  const candidates = findAllLabeledNumbers(
    lines,
    INDUSTRIAL_LABELS.ebit,
    opts,
    pick,
    SCAN_DEFAULT.loose.maxLineLen,
    SCAN_DEFAULT.loose.maxLabelOffset,
  );
  let discardedPortfolioTotal = false;
  for (const m of candidates) {
    const line = lines[m.lineIndex].toLowerCase();
    const headingWindow = lines
      .slice(Math.max(0, m.lineIndex - 10), m.lineIndex + 1)
      .join(' ')
      .toLowerCase();
    const inOperatingSection = INVESTMENT_OPERATING_SECTION_RE.test(headingWindow);
    const looksPortfolio = INVESTMENT_PORTFOLIO_RE.test(line) || INVESTMENT_PORTFOLIO_RE.test(headingWindow);
    if (looksPortfolio && !inOperatingSection) {
      discardedPortfolioTotal = true;
      continue;
    }
    if (inOperatingSection) {
      return { match: m, discardedPortfolioTotal };
    }
  }
  return { match: null, discardedPortfolioTotal };
}

function extractRealEstateEbitProxy(
  lines: string[],
  opts: NumberSearchOpts,
  pick: NumberPickContext,
): NumberMatch | null {
  const reOpts: NumberSearchOpts = { ...opts, exclusions: [] };
  const m = findFinancialNumber(
    lines,
    REAL_ESTATE_EBIT_LABELS_PRIMARY,
    reOpts,
    pick,
    SCAN_DEFAULT,
  );
  if (m === null) return null;
  const around = lines
    .slice(Math.max(0, m.lineIndex - 2), Math.min(lines.length, m.lineIndex + 3))
    .join(' ');
  if (REAL_ESTATE_VALUE_CHANGE_RE.test(around)) {
    return null;
  }
  return m;
}

/**
 * Sequential EBIT strategies: stop at first hit. Returns value, provenance match, and extra notes.
 */
function extractEbitWithStrategies(
  detectedType: CompanyType,
  lines: string[],
  labels: LabelSet,
  unitContext: UnitContext | null,
  revMatch: NumberMatch | null,
  revenue: number | null,
  revProvenance: FieldProvenance | null,
  fallbackFiscalYear: number | null,
  bankScan: ScanConstraints,
): { msek: number | null; match: NumberMatch | null; extraNotes: string[] } {
  const extraNotes: string[] = [];
  const shouldRejectPrimaryEbitAsImplausible = (candidateMsek: number): boolean => {
    if (revenue === null || revenue <= 0) return false;
    const ratio = candidateMsek / Math.max(revenue, 1);
    const absDelta = candidateMsek - revenue;

    if (detectedType === 'bank') {
      // Net interest income / fee lines mapped to revenue_msek are often mis-scaled or
      // not comparable to consolidated operating profit — do not discard a good EBIT
      // row solely because it dominates that proxy (e.g. SEB: NII misread vs op. result).
      if (revenue < 10_000) return false;
      return ratio > 1.35 && absDelta > 20_000;
    }
    if (detectedType === 'real_estate') {
      return ratio > 3;
    }
    // Keep near-parity industrial rows, but reject clearly misaligned picks so
    // fallback strategies (adjusted EBIT / EBITA) can run.
    return ratio > 1.5 && absDelta > 5_000;
  };

  const ebitPick: NumberPickContext = {
    preferredFiscalYear: fallbackFiscalYear,
    revenueRawHintForEbit: revMatch !== null ? revMatch.value : null,
  };
  const revAbsRaw = revMatch !== null ? Math.abs(revMatch.value) : 0;
  const revAbsMsek = revenue !== null ? Math.abs(revenue) : 0;
  const ebitMaxNonBank = Math.max(
    500_000,
    revAbsRaw * 50 + 1,
    revAbsMsek * 50 + 1,
  );
  const ebitOpts: NumberSearchOpts = {
    minValue: detectedType === 'bank' ? -1_000_000 : -500_000,
    maxValue: detectedType === 'bank' ? 1_000_000 : ebitMaxNonBank,
    exclusions: EBIT_EXCLUSIONS,
  };
  const telecomLike = detectedType === 'industrial' && TELECOM_SIGNALS.test(lines.slice(0, 350).join(' '));

  if (detectedType === 'investment_company') {
    const inv = extractInvestmentOperatingEbit(lines, ebitOpts, ebitPick);
    if (inv.match !== null) {
      return {
        msek: normalizeEbitMatchToMsek(inv.match, lines, unitContext),
        match: inv.match,
        extraNotes,
      };
    }
    if (inv.discardedPortfolioTotal) {
      extraNotes.push('EBIT not extracted — investment company, portfolio result excluded');
    }
    return { msek: null, match: null, extraNotes };
  }

  if (detectedType === 'real_estate') {
    const reMatch = extractRealEstateEbitProxy(lines, ebitOpts, ebitPick);
    if (reMatch !== null) {
      const lab = reMatch.label.toLowerCase();
      if (lab === 'förvaltningsresultat') {
        extraNotes.push(
          'EBIT estimated from förvaltningsresultat — real estate reporting, excludes fair value changes and is the primary operating metric for this company type.',
        );
      } else {
        extraNotes.push(
          `EBIT estimated from ${reMatch.label} — real estate reporting, excludes fair value changes`,
        );
      }
      return {
        msek: normalizeEbitMatchToMsek(reMatch, lines, unitContext),
        match: reMatch,
        extraNotes,
      };
    }
  }

  let match: NumberMatch | null =
    detectedType === 'bank'
      ? findFinancialNumberPhased(
          lines,
          BANK_EBIT_LABELS_PRIMARY,
          labels.ebit,
          { ...ebitOpts, exclusions: EBIT_EXCLUSIONS_BANK },
          ebitPick,
          bankScan,
        )
      : findFinancialNumber(lines, labels.ebit, ebitOpts, ebitPick, SCAN_DEFAULT);

  if (telecomLike) {
    const telecomAdjusted = findFinancialNumber(
      lines,
      ADJUSTED_EBIT_LABELS,
      {
        ...ebitOpts,
        exclusions: EBIT_EXCLUSIONS_ADJUSTED_PASS,
      },
      ebitPick,
      SCAN_DEFAULT,
    );
    if (telecomAdjusted !== null) {
      extraNotes.push('EBIT sourced from adjusted variant — preferred for telecom reporting.');
      return {
        msek: normalizeEbitMatchToMsek(telecomAdjusted, lines, unitContext),
        match: telecomAdjusted,
        extraNotes,
      };
    }
  }

  if (match !== null) {
    if (detectedType === 'bank' && match.label.toLowerCase() === BANK_PBT_PROXY_LABEL) {
      extraNotes.push(
        'EBIT estimated from profit before tax — bank reporting, no pure EBIT available',
      );
    }
    const primaryMsek = normalizeEbitMatchToMsek(match, lines, unitContext);
    if (shouldRejectPrimaryEbitAsImplausible(primaryMsek)) {
      extraNotes.push(
        `Primary EBIT candidate ${primaryMsek} MSEK from "${match.label}" rejected — implausibly above revenue ${revenue} MSEK; trying fallback strategies`,
      );
    } else {
      return {
        msek: primaryMsek,
        match,
        extraNotes,
      };
    }
  }

  const adjustedOpts: NumberSearchOpts = {
    ...ebitOpts,
    exclusions: EBIT_EXCLUSIONS_ADJUSTED_PASS,
  };
  match = findFinancialNumber(
    lines,
    ADJUSTED_EBIT_LABELS,
    adjustedOpts,
    ebitPick,
    detectedType === 'bank' ? bankScan : SCAN_DEFAULT,
  );
  if (match !== null) {
    extraNotes.push('EBIT sourced from adjusted variant — verify against reported figure.');
    return {
      msek: normalizeEbitMatchToMsek(match, lines, unitContext),
      match,
      extraNotes,
    };
  }

  const ebitaDerive = extractEbitFromEbitaMinusAmortization(
    lines,
    ebitOpts,
    ebitPick,
    detectedType === 'bank' ? bankScan : SCAN_DEFAULT,
  );
  if (ebitaDerive !== null) {
    if (ebitaDerive.proxyWithoutAmort) {
      extraNotes.push(
        'EBIT estimated from EBITA — amortization not found, may be overstated',
      );
    } else {
      extraNotes.push('EBIT derived from EBITA minus amortization.');
    }
    return {
      msek: normalizeEbitMatchToMsek(ebitaDerive.match, lines, unitContext),
      match: ebitaDerive.match,
      extraNotes,
    };
  }

  if (revenue !== null) {
    match = extractEbitFromOperatingMarginTimesRevenue(
      lines,
      revenue,
      revProvenance,
    );
    if (match !== null) {
      extraNotes.push(
        'EBIT derived from operating margin × revenue — verify against income statement',
      );
      return { msek: match.value, match, extraNotes };
    }
  }

  match = extractEbitFromSegmentResultsBeforeFinancial(lines, ebitOpts, unitContext);
  if (match !== null) {
    extraNotes.push('EBIT derived from sum of segment results — verify consolidation.');
    return {
      msek: normalizeEbitMatchToMsek(match, lines, unitContext),
      match,
      extraNotes,
    };
  }

  return { msek: null, match: null, extraNotes };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function extractFields(
  text: string,
  companyName: string,
  fallbackFiscalYear: number | null,
  reportingModelHint?: ReportingModelHint | null,
): FieldExtractionResult {
  const detectedType = resolveCompanyTypeForExtraction(text, reportingModelHint);
  const labels = getLabels(detectedType);
  const bankScan = detectedType === 'bank' ? SCAN_BANK : SCAN_DEFAULT;
  const lines = text
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const notes: string[] = [];

  log.info(
    `Extracting fields for ${companyName} (type: ${detectedType}${reportingModelHint && reportingModelHint !== 'unspecified' ? `, hint=${reportingModelHint}` : ''}) — ${lines.length} text lines`,
  );

  const unitContext = detectUnitContext(text);
  if (unitContext) {
    log.debug(`Unit context detected: ${unitContext}`);
  }

  // Provenance tracking
  let revProvenance: FieldProvenance | null = null;
  let ebitProvenance: FieldProvenance | null = null;
  let empProvenance: FieldProvenance | null = null;
  let ceoProvenance: FieldProvenance | null = null;

  const tablePickBase: NumberPickContext = {
    preferredFiscalYear: fallbackFiscalYear,
    revenueRawHintForEbit: null,
  };

  // --- Revenue ---
  let revenue: number | null = null;
  let revMatch: NumberMatch | null = null;

  {
    const revMin =
      unitContext === 'eur_m' || unitContext === 'usd_m'
        ? 5
        : unitContext === 'usd_k'
          ? 200_000
          : detectedType === 'bank'
            ? 50
            : detectedType === 'investment_company'
              ? 1
            : 100;
    if (detectedType === 'bank') {
      revMatch = findFinancialNumberPhased(
        lines,
        BANK_REVENUE_LABELS_PRIMARY,
        labels.revenue,
        { minValue: revMin },
        tablePickBase,
        bankScan,
      );
    } else if (detectedType === 'real_estate') {
      revMatch = findFinancialNumberPhased(
        lines,
        REAL_ESTATE_REVENUE_LABELS_PRIMARY,
        labels.revenue,
        { minValue: revMin },
        tablePickBase,
        SCAN_DEFAULT,
      );
    } else if (detectedType === 'investment_company') {
      revMatch = findFinancialNumber(
        lines,
        labels.revenue,
        { minValue: revMin },
        tablePickBase,
        SCAN_DEFAULT,
      );
    } else {
      revMatch = findFinancialNumber(
        lines,
        labels.revenue,
        { minValue: revMin },
        tablePickBase,
        SCAN_DEFAULT,
      );
    }
    if (revMatch !== null) {
      if (hasFusedYearRawArtifact(revMatch.rawCell)) {
        notes.push(`Revenue candidate "${revMatch.rawCell}" discarded — fused-year artifact in raw cell`);
        revMatch = null;
      }
    }
    if (revMatch !== null) {
      let revUnit = revMatch.sectionRange
        ? detectSectionUnitContext(lines, revMatch.sectionRange.start, revMatch.sectionRange.end, unitContext)
        : detectSectionUnitContext(
            lines,
            Math.max(0, revMatch.lineIndex - 2),
            Math.min(lines.length - 1, revMatch.lineIndex + 2),
            unitContext,
          );
      revUnit = resolveUsdAmountUnitForLine(lines, revMatch.lineIndex, revUnit);
      revenue = Math.round(normalizeToMsek(revMatch.value, revUnit));
      revProvenance = numMatchToProvenance(revMatch);
      log.info(`Revenue: ${revenue} MSEK`);
      if (detectedType === 'bank') {
        notes.push(`Bank — '${revMatch.label}' mapped to revenue_msek`);
      }
      if (detectedType === 'investment_company') {
        notes.push(`Investment company — '${revMatch.label}' mapped to revenue_msek`);
      }
      if (revUnit === 'eur_m') {
        notes.push(
          `Revenue converted from EUR millions using approximate EUR/SEK ${EUR_MILLIONS_TO_MSEK_APPROX} — verify report footnote`,
        );
      }
      if (revUnit === 'usd_m') {
        notes.push(
          `Revenue converted from USD millions using approximate USD/SEK ${USD_MILLIONS_TO_MSEK_APPROX} — verify report footnote`,
        );
      }
      if (revUnit === 'usd_k') {
        notes.push(
          `Revenue converted from USD thousands (÷1000 → millions) using approximate USD/SEK ${USD_MILLIONS_TO_MSEK_APPROX} — verify report footnote`,
        );
      }
    }

    // BSEK / Sales narrative (infographics, CEO letter) — fills revenue when tables fail or mispick
    {
      const hit = findNarrativeBsekRevenueHit(text);
      if (hit !== null) {
        if (revenue === null) {
          log.info(`Revenue from narrative (${hit.matchedLabel}): ${hit.msek} MSEK`);
          revenue = hit.msek;
          revProvenance = {
            matchedLabel: hit.matchedLabel,
            rawSnippet: hit.rawSnippet,
            lineIndex: 0,
            context: 'highlights',
          };
          notes.push(`Revenue from narrative (${hit.matchedLabel}): ${hit.msek} MSEK`);
        } else if (revenue < 10_000) {
          if (hit.msek > revenue * 3) {
            log.warn(
              `Revenue ${revenue} MSEK implausibly low — narrative (${hit.matchedLabel}) gives ${hit.msek} MSEK, using that`,
            );
            notes.push(
              `Revenue corrected from ${revenue} to ${hit.msek} MSEK via narrative cross-check (${hit.matchedLabel})`,
            );
            revenue = hit.msek;
            revProvenance = {
              matchedLabel: hit.matchedLabel,
              rawSnippet: hit.rawSnippet,
              lineIndex: 0,
              context: 'highlights',
            };
          }
        }
      }
    }
  }

  // --- EBIT ---
  let ebit: number | null = null;

  const ebitOutcome = extractEbitWithStrategies(
    detectedType,
    lines,
    labels,
    unitContext,
    revMatch,
    revenue,
    revProvenance,
    fallbackFiscalYear,
    bankScan,
  );
  for (const n of ebitOutcome.extraNotes) {
    notes.push(n);
  }
  if (ebitOutcome.msek !== null && ebitOutcome.match !== null) {
    if (hasFusedYearRawArtifact(ebitOutcome.match.rawCell)) {
      notes.push(`EBIT candidate "${ebitOutcome.match.rawCell}" discarded — fused-year artifact in raw cell`);
      ebit = null;
    } else {
    ebit = ebitOutcome.msek;
    ebitProvenance = numMatchToProvenance(ebitOutcome.match);
    log.info(`EBIT: ${ebit} MSEK`);
    if (detectedType === 'bank') {
      notes.push(`Bank — '${ebitOutcome.match.label}' mapped to ebit_msek`);
    }
    const ebitUnit =
      ebitOutcome.match.sectionRange &&
      !/margin|× revenue/i.test(ebitOutcome.match.rawCell)
        ? detectSectionUnitContext(
            lines,
            ebitOutcome.match.sectionRange.start,
            ebitOutcome.match.sectionRange.end,
            unitContext,
          )
        : unitContext;
    if (
      (ebitUnit === 'eur_m' || ebitUnit === 'usd_m' || ebitUnit === 'usd_k') &&
      !/margin|× revenue/i.test(ebitOutcome.match.rawCell)
    ) {
      if (ebitUnit === 'eur_m') {
        notes.push(
          `EBIT converted from EUR millions using approximate EUR/SEK ${EUR_MILLIONS_TO_MSEK_APPROX} — verify report footnote`,
        );
      }
      if (ebitUnit === 'usd_m') {
        notes.push(
          `EBIT converted from USD millions using approximate USD/SEK ${USD_MILLIONS_TO_MSEK_APPROX} — verify report footnote`,
        );
      }
      if (ebitUnit === 'usd_k') {
        notes.push(
          `EBIT converted from USD thousands (÷1000 → millions) using approximate USD/SEK ${USD_MILLIONS_TO_MSEK_APPROX} — verify report footnote`,
        );
      }
    }
    }
  } else {
    notes.push(`EBIT not found for ${companyName}`);
    log.warn(`EBIT not found for ${companyName}`);
  }

  // --- Employees ---
  const empScan = detectedType === 'bank' ? bankScan : SCAN_DEFAULT;
  const empMatch = findLabeledNumber(
    lines,
    labels.employees,
    {
      minValue: 100,
      maxValue: 1_000_000,
    },
    tablePickBase,
    empScan,
  );

  const isFiscalYearMisreadAsEmployees = (val: number, fy: number | null): boolean => {
    const v = Math.round(val);
    if (!Number.isFinite(v) || v < 1900 || v > 2100) return false;
    if (fy == null) return false;
    return fy === v || fy === v - 1 || fy === v + 1;
  };

  let workingEmpMatch: NumberMatch | null = empMatch;
  if (
    workingEmpMatch !== null &&
    isFiscalYearMisreadAsEmployees(workingEmpMatch.value, fallbackFiscalYear)
  ) {
    const bad = Math.round(workingEmpMatch.value);
    notes.push(`Employee count ${bad} discarded — likely fiscal-year column misread`);
    log.warn(`Employees ${bad} looks like fiscal year ${fallbackFiscalYear ?? 'n/a'} — discarding`);
    const pool = findAllLabeledNumbers(
      lines,
      labels.employees,
      { minValue: 100, maxValue: 1_000_000 },
      tablePickBase,
      empScan.loose.maxLineLen,
      empScan.loose.maxLabelOffset,
    );
    const alt = pool.find((m) => !isFiscalYearMisreadAsEmployees(m.value, fallbackFiscalYear));
    workingEmpMatch = alt ?? null;
    if (workingEmpMatch !== null) {
      notes.push(
        `Employees: using alternate labeled hit (${Math.round(workingEmpMatch.value)}) after skipping fiscal-year column`,
      );
    }
  }

  let employees: number | null = null;
  if (workingEmpMatch !== null) {
    const parsedEmployees = Math.round(workingEmpMatch.value);
    const fy = fallbackFiscalYear;
    const yearLike =
      parsedEmployees >= 1900 &&
      parsedEmployees <= 2100 &&
      (fy === parsedEmployees || fy === parsedEmployees - 1 || fy === parsedEmployees + 1);
    if (yearLike) {
      notes.push(`Employee count ${parsedEmployees} discarded — likely fiscal-year column misread`);
      log.warn(`Employees ${parsedEmployees} looks like fiscal year ${fy ?? 'n/a'} — discarding`);
    } else if (detectedType === 'investment_company' && parsedEmployees >= 2_000) {
      notes.push(
        `Employee count ${parsedEmployees} discarded — likely portfolio/holdings headcount for investment company`,
      );
      log.warn(
        `Employees ${parsedEmployees} likely portfolio-level for investment company ${companyName} — discarding`,
      );
    } else {
      let empVal = parsedEmployees;
      const lineText = lines[workingEmpMatch.lineIndex] ?? '';
      const lineWindow = `${lineText} ${lines[workingEmpMatch.lineIndex + 1] ?? ''}`.toLowerCase();
      if (
        empVal >= 50_000 &&
        /\b(in\s+thousands|tusental|employees.*thousand|anställda.*tusen)\b/i.test(lineWindow)
      ) {
        const scaled = Math.round(empVal / 1000);
        if (scaled >= 100 && scaled <= 1_000_000) {
          notes.push(`Employee count scaled ÷1000 (thousands context near employee label)`);
          empVal = scaled;
        }
      }
      employees = empVal;
      empProvenance = numMatchToProvenance(workingEmpMatch);
      log.info(`Employees: ${employees}`);

      if (revenue !== null && revenue >= 1000 && employees > 0 && employees < revenue / 50) {
        const allEmp = findAllLabeledNumbers(
          lines,
          labels.employees,
          { minValue: 100, maxValue: 1_000_000 },
          tablePickBase,
          empScan.loose.maxLineLen,
          empScan.loose.maxLabelOffset,
        );
        const alt = pickBetterEmployeeMatchForRevenue(allEmp, employees, revenue);
        if (alt !== null) {
          notes.push(
            `Employee count revised from ${employees} to ${Math.round(alt.value)} — alternate label row vs revenue plausibility`,
          );
          employees = Math.round(alt.value);
          empProvenance = numMatchToProvenance(alt);
        }
      }

      if (revenue !== null && employees > 0 && employees < revenue / 10) {
        notes.push(`SUSPECT_LOW: ${employees} employees vs ${revenue} MSEK revenue (< 1 per 10 MSEK)`);
        log.warn(`Employee count ${employees} suspiciously low relative to revenue ${revenue} MSEK`);
      }
    }
  } else {
    notes.push(`Employee count not found for ${companyName}`);
    log.warn(`Employees not found for ${companyName}`);
    const narrativeEmp = findNarrativeEmployeeHit(text);
    if (narrativeEmp !== null) {
      employees = narrativeEmp.employees;
      empProvenance = {
        matchedLabel: narrativeEmp.matchedLabel,
        rawSnippet: narrativeEmp.rawSnippet,
        lineIndex: 0,
        context: 'management-section',
      };
      notes.push(
        `Employees from narrative (${narrativeEmp.matchedLabel}): ${narrativeEmp.employees}`,
      );
      log.info(`Employees from narrative fallback: ${narrativeEmp.employees}`);
    }
  }

  // --- CEO ---
  let ceo: string | null = null;
  const ceoMatch = findCeoWithProvenance(lines, labels.ceo);
  if (ceoMatch !== null) {
    if (/single electronic format|electronic format|esef/i.test(ceoMatch.name)) {
      notes.push(`CEO candidate "${ceoMatch.name}" discarded — non-person ESEF phrase`);
      log.warn(`Discarding non-person CEO candidate: ${ceoMatch.name}`);
    } else {
      ceo = ceoMatch.name;
      ceoProvenance = {
        matchedLabel: ceoMatch.label,
        rawSnippet: `${ceoMatch.name} [${ceoMatch.pattern}]`,
        lineIndex: ceoMatch.lineIndex,
        context: ceoMatch.context,
      };
    }
  } else {
    notes.push(`CEO not found for ${companyName}`);
    log.warn(`CEO not found for ${companyName}`);
  }

  // --- Fiscal year ---
  const fiscalYear = findFiscalYear(text, fallbackFiscalYear);
  if (fiscalYear === null) {
    notes.push('Fiscal year not found in PDF text or report URL');
  }

  // Fused text detection: discard numeric fields containing repeated year patterns
  if (revenue !== null && isFusedYearIntegerCorruption(revenue)) {
    notes.push(`Revenue ${revenue} discarded — fused year pattern detected`);
    revenue = null;
    revProvenance = null;
  }
  if (ebit !== null && isFusedYearIntegerCorruption(ebit)) {
    notes.push(`EBIT ${ebit} discarded — fused year pattern detected`);
    ebit = null;
  }

  // After discarding bogus table revenue, retry Sales / BSEK narrative (same patterns as above)
  if (detectedType !== 'investment_company' && revenue === null) {
    const hit = findNarrativeBsekRevenueHit(text);
    if (hit !== null) {
      revenue = hit.msek;
      revProvenance = {
        matchedLabel: hit.matchedLabel,
        rawSnippet: hit.rawSnippet,
        lineIndex: 0,
        context: 'highlights',
      };
      notes.push(`Revenue from narrative after fused-year discard (${hit.matchedLabel}): ${hit.msek} MSEK`);
      log.info(`Revenue from narrative (post-discard): ${hit.msek} MSEK`);
    }
  }

  // Parent-company lines in tkr/KSEK are sometimes parsed with consolidated MSEK context → ~1000× inflation.
  if (detectedType !== 'investment_company' && revenue !== null) {
    const { revenue: rev2, adjusted } = applyRevenueMegascaleMsekGuard(revenue, detectedType);
    if (adjusted) {
      log.warn(
        `Revenue ${revenue} MSEK exceeds megascale threshold for ${detectedType} — applying ÷1000 unit guard → ${rev2} MSEK`,
      );
      notes.push(
        `Revenue unit guard: ${revenue} → ${rev2} MSEK (likely tkr/KSEK misread as MSEK)`,
      );
      revenue = rev2;
    }
  }

  if (ebit !== null) {
    const ebitGuard = applyEbitMegascaleGuard(ebit, revenue);
    if (ebitGuard.adjusted) {
      notes.push(`EBIT unit guard: ${ebit} → ${ebitGuard.ebit} MSEK (likely tkr/KSEK misread as MSEK)`);
      log.warn(
        `EBIT ${ebit} MSEK appears unit-inflated versus revenue ${revenue ?? 'n/a'} — applying ÷1000 guard → ${ebitGuard.ebit} MSEK`,
      );
      ebit = ebitGuard.ebit;
    }
  }

  if (detectedType !== 'investment_company' && revenue === null) {
    notes.push(`Revenue not found for ${companyName}`);
    log.warn(`Revenue not found for ${companyName}`);
  }

  // Explicit assignment-schema mapping (native label → revenue_msek / ebit_msek)
  if (detectedType !== 'investment_company' && (revProvenance || ebitProvenance)) {
    const revMap = classifyRevenueMapping(detectedType, revProvenance?.matchedLabel ?? null);
    const ebitMap = classifyEbitMapping(detectedType, ebitProvenance?.matchedLabel ?? null);
    notes.push(...formatMappingNotes([revMap, ebitMap]));
  }

  return {
    data: {
      revenue_msek: revenue,
      ebit_msek: ebit,
      employees,
      ceo,
    },
    fiscalYear,
    detectedCompanyType: detectedType,
    provenance: {
      revenue: revProvenance,
      ebit: ebitProvenance,
      employees: empProvenance,
      ceo: ceoProvenance,
    },
    notes,
  };
}

// ---------------------------------------------------------------------------
// Second-pass EBIT (consolidated income sections only) — pre-validation repair
// ---------------------------------------------------------------------------

/**
 * Re-scan labeled EBIT/operating lines only inside detected consolidated income-statement
 * windows (skips highlights / front-matter picks that often mis-scale).
 */
export function extractEbitSecondPassFromIncomeSections(
  text: string,
  companyType: CompanyType,
  fallbackFiscalYear: number | null,
  revenueMsek: number | null,
): { ebit_msek: number | null; notes: string[] } {
  const notes: string[] = [];
  if (companyType === 'investment_company') {
    return { ebit_msek: null, notes };
  }

  const lines = text
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const unitContext = detectUnitContext(text);
  const sections = findIncomeStatementSections(lines);
  if (sections.length === 0) {
    notes.push('Second-pass EBIT: no consolidated income statement window found');
    return { ebit_msek: null, notes };
  }

  const revAbs = revenueMsek !== null ? Math.abs(revenueMsek) : 0;
  const ebitMax =
    companyType === 'bank' ? 1_000_000 : Math.max(500_000, revAbs * 50 + 1, 50_000);
  const ebitOpts: NumberSearchOpts = {
    minValue: companyType === 'bank' ? -1_000_000 : -500_000,
    maxValue: ebitMax,
    exclusions: EBIT_EXCLUSIONS,
  };
  const ebitPick: NumberPickContext = {
    preferredFiscalYear: fallbackFiscalYear,
    revenueRawHintForEbit: null,
  };

  const sorted = [...sections].sort((a, b) => b.end - b.start - (a.end - a.start));

  for (const sec of sorted) {
    const slice = lines.slice(sec.start, sec.end);
    let match: NumberMatch | null = null;

    if (companyType === 'bank') {
      match = findLabeledNumber(
        slice,
        BANK_EBIT_LABELS_PRIMARY,
        { ...ebitOpts, exclusions: EBIT_EXCLUSIONS_BANK },
        ebitPick,
        SCAN_BANK,
      );
      if (match === null) {
        match = findLabeledNumber(
          slice,
          getLabels('bank').ebit,
          { ...ebitOpts, exclusions: EBIT_EXCLUSIONS_BANK },
          ebitPick,
          SCAN_BANK,
        );
      }
      if (match === null) {
        match = findLabeledNumber(
          slice,
          ADJUSTED_EBIT_LABELS,
          { ...ebitOpts, exclusions: EBIT_EXCLUSIONS_ADJUSTED_PASS },
          ebitPick,
          SCAN_BANK,
        );
        if (match !== null) {
          notes.push('Second-pass EBIT: using adjusted operating result line (bank)');
        }
      }
    } else if (companyType === 'real_estate') {
      match = extractRealEstateEbitProxy(slice, ebitOpts, ebitPick);
    } else {
      match = findLabeledNumber(slice, INDUSTRIAL_LABELS.ebit, ebitOpts, ebitPick, SCAN_DEFAULT);
      if (match === null) {
        match = findLabeledNumber(
          slice,
          ADJUSTED_EBIT_LABELS,
          { ...ebitOpts, exclusions: EBIT_EXCLUSIONS_ADJUSTED_PASS },
          ebitPick,
          SCAN_DEFAULT,
        );
        if (match !== null) {
          notes.push('Second-pass EBIT: using adjusted operating result line');
        }
      }
    }

    if (match === null) continue;

    const globalIdx = sec.start + match.lineIndex;
    const globalMatch: NumberMatch = {
      ...match,
      lineIndex: globalIdx,
      sectionRange: { start: sec.start, end: sec.end },
      context: 'income-statement',
    };

    if (hasFusedYearRawArtifact(globalMatch.rawCell)) continue;
    if (isGhostSegmentEbitHeaderMatch(globalMatch, lines)) continue;
    if (isInSegmentSection(globalIdx, lines)) continue;

    let msek = normalizeEbitMatchToMsek(globalMatch, lines, unitContext);
    const ebitGuard = applyEbitMegascaleGuard(msek, revenueMsek);
    if (ebitGuard.adjusted) {
      notes.push(`Second-pass EBIT unit guard: ${msek} → ${ebitGuard.ebit} MSEK`);
      msek = ebitGuard.ebit;
    }

    if (revenueMsek !== null && revenueMsek > 0) {
      if (companyType === 'bank') {
        const ratio = msek / revenueMsek;
        const absDelta = msek - revenueMsek;
        if (ratio > 1.35 || absDelta > 20_000) {
          continue;
        }
      } else if (companyType === 'real_estate') {
        if (msek > revenueMsek * 3) {
          continue;
        }
      } else if (msek > revenueMsek * 1.05) {
        continue;
      }
    }

    notes.push(
      `Second-pass EBIT from consolidated income section (${globalMatch.label}): ${msek} MSEK`,
    );
    return { ebit_msek: msek, notes };
  }

  notes.push('Second-pass EBIT: no acceptable line in income statement windows');
  return { ebit_msek: null, notes };
}
