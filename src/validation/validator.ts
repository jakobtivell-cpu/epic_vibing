// ---------------------------------------------------------------------------
// Validation — sanity-checks extracted data and assigns a confidence score.
// Values that fail hard constraints are nulled out (never returned unchecked).
// ---------------------------------------------------------------------------

import { ExtractedData, CompanyType } from '../types';
import { createLogger } from '../utils/logger';

const log = createLogger('validation');

export interface ValidationResult {
  data: ExtractedData;
  confidence: number; // 0–100
  warnings: string[];
}

const CURRENT_YEAR = new Date().getFullYear();

export function validateExtractedData(
  data: ExtractedData,
  companyType: CompanyType,
  pipelineNotes?: string[],
): ValidationResult {
  const warnings: string[] = [];
  let score = 100;
  const cleaned: ExtractedData = { ...data };

  // --- Revenue ---
  if (cleaned.revenue_msek === null) {
    warnings.push('Revenue not extracted');
    score -= 20;
  } else if (cleaned.revenue_msek <= 0 && companyType !== 'investment_company') {
    warnings.push(`Revenue non-positive (${cleaned.revenue_msek}) — discarded`);
    cleaned.revenue_msek = null;
    score -= 15;
  } else if (cleaned.revenue_msek > 5_000_000) {
    warnings.push(`Revenue implausibly high (${cleaned.revenue_msek} MSEK) — discarded`);
    cleaned.revenue_msek = null;
    score -= 15;
  } else if (cleaned.revenue_msek < 10_000 && companyType === 'industrial') {
    warnings.push(
      `Revenue ${cleaned.revenue_msek} MSEK is below 10,000 MSEK — unusually low for Large Cap industrial`,
    );
    score -= 10;
  }

  // --- EBIT ---
  if (cleaned.ebit_msek === null) {
    warnings.push('EBIT not extracted');
    score -= 15;
  } else if (Math.abs(cleaned.ebit_msek) > 2_000_000) {
    warnings.push(`EBIT implausibly large (${cleaned.ebit_msek} MSEK) — discarded`);
    cleaned.ebit_msek = null;
    score -= 15;
  }

  // EBIT must not exceed revenue (basic accounting constraint)
  if (
    cleaned.revenue_msek !== null &&
    cleaned.ebit_msek !== null &&
    cleaned.ebit_msek > cleaned.revenue_msek
  ) {
    warnings.push(
      `EBIT (${cleaned.ebit_msek}) exceeds revenue (${cleaned.revenue_msek}) — likely extraction error, discarding EBIT`,
    );
    cleaned.ebit_msek = null;
    score -= 15;
  }

  // --- Employees ---
  if (cleaned.employees === null) {
    warnings.push('Employee count not extracted');
    score -= 15;
  } else if (cleaned.employees < 50) {
    warnings.push(`Employee count too low (${cleaned.employees}) — discarded`);
    cleaned.employees = null;
    score -= 15;
  } else if (cleaned.employees > 700_000) {
    warnings.push(`Employee count implausibly high (${cleaned.employees}) — discarded`);
    cleaned.employees = null;
    score -= 15;
  }

  // --- CEO ---
  if (cleaned.ceo === null) {
    warnings.push('CEO not extracted');
    score -= 15;
  } else {
    const words = cleaned.ceo.trim().split(/\s+/);
    if (words.length < 2) {
      warnings.push(`CEO name has only one word ("${cleaned.ceo}") — suspect`);
      score -= 5;
    }
  }

  // --- Confidence penalties for upstream warnings ---
  if (pipelineNotes) {
    if (pipelineNotes.some((n) => n.startsWith('ENTITY WARNING'))) {
      warnings.push('Entity verification failed — low trust in all extracted values');
      score -= 25;
    }
    if (pipelineNotes.some((n) => n.startsWith('CONTENT WARNING'))) {
      warnings.push('Content type suspect — data may be from wrong report type');
      score -= 15;
    }
    if (pipelineNotes.some((n) => /fiscal year mismatch/i.test(n))) {
      score -= 10;
    }
  }

  score = Math.max(0, Math.min(100, score));

  if (warnings.length > 0) {
    log.warn(`Validation warnings: ${warnings.join('; ')}`);
  }
  log.info(`Validation confidence: ${score}/100`);

  return { data: cleaned, confidence: score, warnings };
}
