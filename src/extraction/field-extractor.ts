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
  LabelSet,
} from './labels';
import { createLogger } from '../utils/logger';
import { EUR_MILLIONS_TO_MSEK_APPROX } from '../config/settings';
import { parseNumber } from './number-parse';
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

  if (investScore >= 3) return 'investment_company';
  if (bankScore >= 2) return 'bank';

  return 'industrial';
}

/** Merge legal-name hint with PDF signals — hint wins for bank / investment when set. */
export function resolveCompanyTypeForExtraction(
  text: string,
  hint?: ReportingModelHint | null,
): CompanyType {
  const detected = detectCompanyType(text);
  if (hint === 'bank') return 'bank';
  if (hint === 'investment_company') return 'investment_company';
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
  const parts = t.split(/\s{2,}|\t+/).map((p) => p.trim()).filter(Boolean);
  const years: number[] = [];
  for (const p of parts) {
    const m = p.match(/\b(20[12]\d)\b/);
    if (m) years.push(parseInt(m[1], 10));
  }
  return years.length >= 2 ? years : [];
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
    if (seq.length < 2 || !pick?.preferredFiscalYear) continue;
    const yIdx = seq.lastIndexOf(pick.preferredFiscalYear);
    if (yIdx < 0) continue;
    const dataIdx = Math.min(yIdx, candidates.length - 1);
    const chosen = candidates.find((c) => c.idx === dataIdx);
    if (chosen) return chosen;
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

function isSkippableCell(cell: string): boolean {
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

type UnitContext = 'msek' | 'bsek' | 'ksek' | 'sek' | 'eur_m';

function detectUnitContext(text: string): UnitContext | null {
  const lower = text.toLowerCase();
  // SEK units before EUR — many PDFs mention EUR/FX in notes but report in SEK.
  if (
    /amounts?\s+in\s+sek\s*m\b/.test(lower) ||
    /belopp\s+i\s+msek\b/.test(lower) ||
    /amounts?\s+in\s+msek\b/.test(lower) ||
    /sek\s+millions?\b/.test(lower) ||
    /\bmkr\b/.test(lower)
  ) {
    return 'msek';
  }

  if (
    /amounts?\s+in\s+sek\s*bn\b/.test(lower) ||
    /amounts?\s+in\s+bsek\b/.test(lower) ||
    /\bmdkr\b/.test(lower) ||
    /\bamounts?\s+in\s+sek\s*billion/i.test(lower) ||
    /\bbillion\s+sek\b/.test(lower) ||
    /\bmiljard(er)?\s+sek\b/.test(lower) ||
    /\bsek\s*billion\b/.test(lower)
  ) {
    return 'bsek';
  }

  if (
    /amounts?\s+in\s+ksek\b/.test(lower) ||
    /amounts?\s+in\s+sek\s*k\b/.test(lower) ||
    /\btkr\b/.test(lower)
  ) {
    return 'ksek';
  }

  if (
    /\bamounts?\s+in\s+(?:million\s+)?euros?\b/.test(lower) ||
    /\bin\s+eur\s*m\b/.test(lower) ||
    /\bmeur\b/.test(lower) ||
    /\b€\s*m\b/.test(lower) ||
    /\beur\s*million/i.test(lower) ||
    /\bmillion\s+euros?\b/.test(lower) ||
    /\belopp\s+i\s+meur\b/.test(lower) ||
    /\bi\s+miljoner\s+euro\b/.test(lower)
  ) {
    return 'eur_m';
  }

  return null;
}

/** Parsed BSEK-style revenue from narrative / infographic text (not tables). */
interface NarrativeBsekHit {
  msek: number;
  matchedLabel: string;
  rawSnippet: string;
}

function isPlausibleBsekBillions(val: number): boolean {
  return !isNaN(val) && val >= 1 && val <= 2_000;
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

  return tryPatterns(salesPatterns) ?? tryPatterns(genericPatterns);
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
    case 'msek':
    default:
      return value;
  }
}

/**
 * Detect unit context within a specific line range (e.g., an income
 * statement section). Falls back to the global context if no local
 * indicator is found. This prevents a global "BSEK" indicator from
 * being applied to a section that declares "Amounts in SEK m".
 */
function detectSectionUnitContext(
  lines: string[],
  start: number,
  end: number,
  globalUnit: UnitContext | null,
): UnitContext | null {
  const window = Math.min(start + 5, end);
  for (let i = Math.max(0, start - 3); i < window; i++) {
    const lineUnit = detectUnitContext(lines[i]);
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
  /\bjämförelsestörande\b/i,
  /\bitems\s+affecting\s+comparability\b/i,
  /\bexkl\.\s/i,
  /\bexcluding\s/i,
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
    for (let j = i + 3; j < end; j++) {
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

  // Last resort: return any match (even from segment sections)
  if (allMatches.length > 0) {
    allMatches[0].context = 'segment-fallback';
    log.debug(
      `Using segment-section value ${allMatches[0].value} as last resort (line ${allMatches[0].lineIndex})`,
    );
    return allMatches[0];
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
  if (stdCells.length >= 2) return stdCells;

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

      if (labelIdx >= 6) {
        const before = lineLower.substring(Math.max(0, labelIdx - 6), labelIdx).trim();
        if (/\bother$/.test(before)) continue;
      }

      if (exclusions && exclusions.some((ex) => ex.test(lineLower))) continue;

      let afterLabel = lines[i].substring(labelIdx + label.length);
      afterLabel = afterLabel.replace(/^[)}\]]+/, '');
      afterLabel = stripLeadingNoteRef(afterLabel);

      const searchText =
        afterLabel + (i + 1 < lines.length ? '  ' + lines[i + 1] : '');

      const cells = splitIntoCells(searchText);

      const chosen = selectBestNumericFromCells(cells, lines, i, opts, pickContext);
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

/**
 * Extract individual number tokens from text that may lack proper whitespace.
 */
function extractNumberTokens(text: string): string[] {
  const tokens: string[] = [];
  const numberRe = /[-–−]?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|[-–−]?\d{4,}(?:\.\d{1,2})?/g;
  let m;
  while ((m = numberRe.exec(text)) !== null) {
    tokens.push(m[0]);
  }
  return tokens;
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

      if (labelIdx >= 6) {
        const before = lineLower.substring(Math.max(0, labelIdx - 6), labelIdx).trim();
        if (/\bother$/.test(before)) continue;
      }

      if (exclusions && exclusions.some((ex) => ex.test(lineLower))) continue;

      let afterLabel = lines[i].substring(labelIdx + label.length);
      afterLabel = afterLabel.replace(/^[)}\]]+/, '');
      afterLabel = stripLeadingNoteRef(afterLabel);

      const searchText =
        afterLabel + (i + 1 < lines.length ? '  ' + lines[i + 1] : '');

      const cells = splitIntoCells(searchText);

      const chosen = selectBestNumericFromCells(cells, lines, i, opts, pickContext);
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

      const directTokens = extractNumberTokens(afterLabel);
      for (const token of directTokens) {
        if (/^20[12]\d$/.test(token)) continue;
        const value = parseNumber(token);
        if (value === null) continue;
        if (value < minValue || value > maxValue) continue;

        log.debug(`Found "${label}": ${value} (direct-extract: "${token}")`);
        return { value, lineIndex: i, label, rawCell: token, context: 'general' };
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

  if (detectedType === 'investment_company') {
    notes.push('Investment company — standard revenue/EBIT not applicable');
  } else {
    const revMin = detectedType === 'bank' ? 50 : 100;
    if (detectedType === 'bank') {
      revMatch = findFinancialNumberPhased(
        lines,
        BANK_REVENUE_LABELS_PRIMARY,
        labels.revenue,
        { minValue: revMin },
        tablePickBase,
        bankScan,
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
      const revUnit = revMatch.sectionRange
        ? detectSectionUnitContext(lines, revMatch.sectionRange.start, revMatch.sectionRange.end, unitContext)
        : unitContext;
      revenue = Math.round(normalizeToMsek(revMatch.value, revUnit));
      revProvenance = numMatchToProvenance(revMatch);
      log.info(`Revenue: ${revenue} MSEK`);
      if (detectedType === 'bank') {
        notes.push(`Bank — '${revMatch.label}' mapped to revenue_msek`);
      }
      if (revUnit === 'eur_m') {
        notes.push(
          `Revenue converted from EUR millions using approximate EUR/SEK ${EUR_MILLIONS_TO_MSEK_APPROX} — verify report footnote`,
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

  if (detectedType !== 'investment_company') {
    const ebitPick: NumberPickContext = {
      preferredFiscalYear: fallbackFiscalYear,
      revenueRawHintForEbit: revMatch !== null ? revMatch.value : null,
    };
    const ebitOpts: NumberSearchOpts = {
      minValue: detectedType === 'bank' ? -1_000_000 : -500_000,
      maxValue: detectedType === 'bank' ? 1_000_000 : 500_000,
      exclusions: EBIT_EXCLUSIONS,
    };
    const ebitMatch =
      detectedType === 'bank'
        ? findFinancialNumberPhased(
            lines,
            BANK_EBIT_LABELS_PRIMARY,
            labels.ebit,
            ebitOpts,
            ebitPick,
            bankScan,
          )
        : findFinancialNumber(lines, labels.ebit, ebitOpts, ebitPick, SCAN_DEFAULT);
    if (ebitMatch !== null) {
      const ebitUnit = ebitMatch.sectionRange
        ? detectSectionUnitContext(lines, ebitMatch.sectionRange.start, ebitMatch.sectionRange.end, unitContext)
        : unitContext;
      ebit = Math.round(normalizeToMsek(ebitMatch.value, ebitUnit));
      ebitProvenance = numMatchToProvenance(ebitMatch);
      log.info(`EBIT: ${ebit} MSEK`);
      if (detectedType === 'bank') {
        notes.push(`Bank — '${ebitMatch.label}' mapped to ebit_msek`);
      }
      if (ebitUnit === 'eur_m') {
        notes.push(
          `EBIT converted from EUR millions using approximate EUR/SEK ${EUR_MILLIONS_TO_MSEK_APPROX} — verify report footnote`,
        );
      }
    } else {
      notes.push(`EBIT not found for ${companyName}`);
      log.warn(`EBIT not found for ${companyName}`);
    }
  }

  // --- Employees ---
  const empMatch = findLabeledNumber(
    lines,
    labels.employees,
    {
      minValue: 100,
      maxValue: 1_000_000,
    },
    tablePickBase,
    detectedType === 'bank' ? bankScan : SCAN_DEFAULT,
  );
  let employees: number | null = null;
  if (empMatch !== null) {
    employees = Math.round(empMatch.value);
    empProvenance = numMatchToProvenance(empMatch);
    log.info(`Employees: ${employees}`);

    // Plausibility: at least 1 employee per 10 MSEK of revenue
    if (revenue !== null && employees > 0 && employees < revenue / 10) {
      notes.push(`SUSPECT_LOW: ${employees} employees vs ${revenue} MSEK revenue (< 1 per 10 MSEK)`);
      log.warn(`Employee count ${employees} suspiciously low relative to revenue ${revenue} MSEK`);
    }
  } else {
    notes.push(`Employee count not found for ${companyName}`);
    log.warn(`Employees not found for ${companyName}`);
  }

  // --- CEO ---
  let ceo: string | null = null;
  const ceoMatch = findCeoWithProvenance(lines, labels.ceo);
  if (ceoMatch !== null) {
    ceo = ceoMatch.name;
    ceoProvenance = {
      matchedLabel: ceoMatch.label,
      rawSnippet: `${ceoMatch.name} [${ceoMatch.pattern}]`,
      lineIndex: ceoMatch.lineIndex,
      context: ceoMatch.context,
    };
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
  const fusedYearRe = /(20\d{2}){2,}/;
  if (revenue !== null && fusedYearRe.test(String(revenue))) {
    notes.push(`Revenue ${revenue} discarded — fused year pattern detected`);
    revenue = null;
    revProvenance = null;
  }
  if (ebit !== null && fusedYearRe.test(String(ebit))) {
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
  if (detectedType !== 'investment_company' && revenue !== null && revenue > 1_000_000) {
    const corrected = Math.round(revenue / 1000);
    log.warn(
      `Revenue ${revenue} MSEK exceeds 1,000,000 — applying ÷1000 unit guard → ${corrected} MSEK`,
    );
    notes.push(
      `Revenue unit guard: ${revenue} → ${corrected} MSEK (likely tkr/KSEK misread as MSEK)`,
    );
    revenue = corrected;
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
