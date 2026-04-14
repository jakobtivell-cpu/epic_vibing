// ---------------------------------------------------------------------------
// When to run the LLM challenger — conservative gate (cost + precision).
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import { join } from 'path';
import type { ExtractedData, ResultStatus, CompanyType } from '../types';

export interface ChallengerGateInput {
  hasPdfText: boolean;
  /** True when pdf-parse reported unusually short text for page count. */
  suspiciouslyShortPdf: boolean;
  confidence: number | null;
  status: ResultStatus;
  extractedData: ExtractedData | null;
  fiscalYear: number | null;
  companyName: string;
  ticker: string | null;
  detectedCompanyType: CompanyType | null;
  /** Pipeline extraction notes used to detect non-recoverable partials. */
  extractionNotes?: string[];
  /** CLI / options override — run whenever API key exists. */
  forceLlm: boolean;
}

interface HardList {
  companyNames?: string[];
  tickers?: string[];
}

let cachedHard: HardList | null = null;

function loadHardList(): HardList {
  if (cachedHard) return cachedHard;
  const candidates = [
    join(process.cwd(), 'data', 'challenger-hard.json'),
    join(__dirname, '..', '..', 'data', 'challenger-hard.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        cachedHard = JSON.parse(fs.readFileSync(p, 'utf-8')) as HardList;
        return cachedHard;
      }
    } catch {
      /* ignore */
    }
  }
  cachedHard = {};
  return cachedHard;
}

function isHardCompany(input: ChallengerGateInput): boolean {
  const h = loadHardList();
  const names = (h.companyNames ?? []).map((s) => s.toLowerCase());
  const tickers = (h.tickers ?? []).map((s) => s.toUpperCase());
  if (names.includes(input.companyName.toLowerCase())) return true;
  if (input.ticker && tickers.includes(input.ticker.toUpperCase())) return true;
  return false;
}

function notesBlob(input: ChallengerGateInput): string {
  return (input.extractionNotes ?? []).join(' | ').toLowerCase();
}

function hasWrongDocumentSignals(input: ChallengerGateInput): boolean {
  const blob = notesBlob(input);
  return (
    /governance report|corporate governance report|quarterly report/.test(blob) ||
    /no income statement|no consolidated income statement|no balance sheet/.test(blob)
  );
}

function hasSevereNumericCorruptionSignals(input: ChallengerGateInput): boolean {
  const blob = notesBlob(input);
  return (
    /fused year pattern detected/.test(blob) ||
    /implausibly large/.test(blob) ||
    /stage budget exhausted/.test(blob)
  );
}

function hasRecoverableGap(input: ChallengerGateInput): boolean {
  const d = input.extractedData;
  if (!d) return false;
  // EBIT-only gaps are the highest-value recoverable target.
  if (d.ebit_msek === null && d.revenue_msek !== null) return true;
  // Personnel fields are often recoverable from narrative sections.
  if (d.employees === null || d.ceo === null) return true;
  // Revenue-only nulls can still be recoverable from alternate labels in statement tables.
  if (d.revenue_msek === null && d.ebit_msek !== null) return true;
  return false;
}

/**
 * Run LLM pass only when warranted, unless forceLlm (and API key present).
 * Investment companies: skip by default (standard revenue/EBIT often N/A).
 */
export function shouldRunLlmChallenger(
  input: ChallengerGateInput,
  hasApiKey: boolean,
): boolean {
  if (!hasApiKey) return false;
  if (!input.hasPdfText) return false;
  if (input.status === 'timeout') return false;
  if (input.forceLlm) return true;

  if (input.detectedCompanyType === 'investment_company') {
    return false;
  }

  if (isHardCompany(input)) return true;

  const d = input.extractedData;
  if (!d) return false;
  if (input.status !== 'partial' && input.status !== 'failed') return false;
  if (input.suspiciouslyShortPdf) return false;
  if (input.confidence === null || input.confidence < 80) return false;
  if (hasWrongDocumentSignals(input)) return false;
  if (hasSevereNumericCorruptionSignals(input)) return false;

  if (!hasRecoverableGap(input)) return false;

  return true;
}
