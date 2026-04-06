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
  if (input.suspiciouslyShortPdf) return true;

  if (input.confidence !== null && input.confidence < 85) return true;
  if (input.status === 'partial' || input.status === 'failed') return true;

  const d = input.extractedData;
  if (!d) return true;
  if (
    d.revenue_msek === null ||
    d.ebit_msek === null ||
    d.employees === null ||
    d.ceo === null
  ) {
    return true;
  }
  if (input.fiscalYear === null) return true;

  return false;
}
