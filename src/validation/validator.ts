// ---------------------------------------------------------------------------
// Validation — sanity-checks extracted data and assigns a confidence score.
// Rules depend on detected reporting model (industrial / bank / investment).
// ---------------------------------------------------------------------------

import { ExtractedData, CompanyType } from '../types';
import { createLogger } from '../utils/logger';

const log = createLogger('validation');

export interface ValidationResult {
  data: ExtractedData;
  confidence: number; // 0–100
  warnings: string[];
}

export function validateExtractedData(
  data: ExtractedData,
  detectedCompanyType?: CompanyType,
  pipelineNotes?: string[],
): ValidationResult {
  const warnings: string[] = [];
  let score = 100;
  const cleaned: ExtractedData = { ...data };
  const companyType = detectedCompanyType ?? 'industrial';

  // --- Revenue ---
  if (cleaned.revenue_msek === null) {
    warnings.push('Revenue not extracted');
    score -= 20;
  } else if (cleaned.revenue_msek <= 0 && companyType !== 'investment_company') {
    warnings.push(`Revenue non-positive (${cleaned.revenue_msek}) — discarded`);
    cleaned.revenue_msek = null;
    score -= 15;
  } else if (cleaned.revenue_msek > (companyType === 'bank' ? 50_000_000 : 5_000_000)) {
    warnings.push(`Revenue implausibly high (${cleaned.revenue_msek} MSEK) — discarded`);
    cleaned.revenue_msek = null;
    score -= 15;
  } else if (
    companyType === 'bank' &&
    cleaned.revenue_msek > 0 &&
    cleaned.revenue_msek < 10_000
  ) {
    // Banks' operating-income lines can be mis-scaled or segment-level; do not apply industrial floor
    warnings.push(
      `Bank revenue-equivalent ${cleaned.revenue_msek} MSEK below 10,000 — verify units (kept; not an industrial Large Cap gate)`,
    );
    score -= 6;
  } else if (companyType === 'industrial' && cleaned.revenue_msek < 1_000) {
    warnings.push(`Revenue ${cleaned.revenue_msek} MSEK below 1,000 — implausible for Large Cap industrial`);
    cleaned.revenue_msek = null;
    score -= 15;
  } else if (companyType === 'bank' && cleaned.revenue_msek < 1_000) {
    warnings.push(
      `Bank revenue-equivalent ${cleaned.revenue_msek} MSEK below 1,000 — may be unit/segment error; kept with low trust`,
    );
    score -= 10;
  }

  // --- EBIT ---
  if (cleaned.ebit_msek === null) {
    warnings.push('EBIT not extracted');
    score -= 15;
  } else if (Math.abs(cleaned.ebit_msek) > (companyType === 'bank' ? 3_000_000 : 2_000_000)) {
    warnings.push(`EBIT implausibly large (${cleaned.ebit_msek} MSEK) — discarded`);
    cleaned.ebit_msek = null;
    score -= 15;
  }

  const realEstateForvaltEbitFromNotes =
    companyType === 'real_estate' &&
    pipelineNotes?.some(
      (n) =>
        n.includes('EBIT estimated from förvaltningsresultat') &&
        n.includes('primary operating metric'),
    );

  if (
    cleaned.revenue_msek !== null &&
    cleaned.ebit_msek !== null &&
    cleaned.ebit_msek > cleaned.revenue_msek
  ) {
    if (realEstateForvaltEbitFromNotes) {
      warnings.push(
        `Real estate: förvaltningsresultat (${cleaned.ebit_msek} MSEK) above revenue proxy (${cleaned.revenue_msek} MSEK) — kept; lines are not directly comparable to industrial EBIT vs revenue`,
      );
      score -= 4;
    } else if (companyType === 'bank') {
      const ratio = cleaned.ebit_msek / Math.max(cleaned.revenue_msek, 1);
      const absDelta = cleaned.ebit_msek - cleaned.revenue_msek;
      if (ratio <= 1.3 && absDelta <= 15_000) {
        warnings.push(
          `Bank: operating result (${cleaned.ebit_msek}) above revenue-equivalent (${cleaned.revenue_msek}) — may reflect credit-loss / line definitions; kept`,
        );
        score -= 5;
      } else {
        warnings.push(
          `Bank: operating result (${cleaned.ebit_msek}) exceeds revenue-equivalent (${cleaned.revenue_msek}) — possible semantic mismatch; discarding EBIT for assignment safety`,
        );
        cleaned.ebit_msek = null;
        score -= 12;
      }
    } else if (companyType === 'real_estate') {
      const ratio = cleaned.ebit_msek / Math.max(cleaned.revenue_msek, 1);
      if (realEstateForvaltEbitFromNotes || ratio <= 1.05) {
        warnings.push(
          `Real estate: operating metric (${cleaned.ebit_msek} MSEK) above revenue proxy (${cleaned.revenue_msek} MSEK) — kept; lines often not directly comparable`,
        );
        score -= 5;
      } else {
        warnings.push(
          `EBIT (${cleaned.ebit_msek}) exceeds revenue (${cleaned.revenue_msek}) — likely extraction error, discarding EBIT`,
        );
        cleaned.ebit_msek = null;
        score -= 15;
      }
    } else {
      const ratio = cleaned.ebit_msek / Math.max(cleaned.revenue_msek, 1);
      const absDelta = cleaned.ebit_msek - cleaned.revenue_msek;
      // IFRS / FX / segment vs consolidated labels sometimes land a few % above net sales;
      // keep a tight band plus a slightly wider band with capped absolute gap (partial-row cluster).
      if (
        (ratio <= 1.03 && absDelta <= 3_000) ||
        (ratio <= 1.15 && absDelta <= 2_000)
      ) {
        warnings.push(
          `Industrial: EBIT (${cleaned.ebit_msek}) slightly above revenue (${cleaned.revenue_msek}) — kept within near-parity tolerance`,
        );
        score -= 4;
      } else {
        warnings.push(
          `EBIT (${cleaned.ebit_msek}) exceeds revenue (${cleaned.revenue_msek}) — likely extraction error, discarding EBIT`,
        );
        cleaned.ebit_msek = null;
        score -= 15;
      }
    }
  }

  const employeeIndustrialFloorRelaxed =
    pipelineNotes?.some((n) =>
      /segment-level|parent[\s-]company|moderbolag|non[\s-]consolidated|huvudkontor\s+only/i.test(n),
    ) ?? false;

  // --- Employees ---
  if (cleaned.employees === null) {
    warnings.push('Employee count not extracted');
    score -= 15;
  } else if (companyType === 'industrial' && cleaned.employees < 100) {
    if (employeeIndustrialFloorRelaxed && cleaned.employees >= 20) {
      warnings.push(
        `Employee count ${cleaned.employees} below industrial large-cap floor — kept; pipeline notes indicate parent/segment/non-consolidated context`,
      );
      score -= 8;
    } else {
      warnings.push(`Employee count too low (${cleaned.employees}) for industrial large-cap — discarded`);
      cleaned.employees = null;
      score -= 15;
    }
  } else if (cleaned.employees < 50) {
    warnings.push(`Employee count too low (${cleaned.employees}) — discarded`);
    cleaned.employees = null;
    score -= 15;
  } else if (cleaned.employees > 700_000) {
    warnings.push(`Employee count implausibly high (${cleaned.employees}) — discarded`);
    cleaned.employees = null;
    score -= 15;
  }

  // Bank: employee vs revenue-equivalent ratios differ from industrial
  if (companyType === 'bank' && cleaned.revenue_msek !== null && cleaned.employees !== null) {
    if (cleaned.employees < cleaned.revenue_msek / 50) {
      warnings.push('Bank: employee count low vs operating income — verify consolidated figures');
      score -= 5;
    }
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

  // --- Investment company ---
  if (companyType === 'investment_company') {
    if (cleaned.revenue_msek !== null || cleaned.ebit_msek !== null) {
      warnings.push('Investment company — revenue/EBIT may not match industrial definitions');
      score -= 8;
    }
  }

  // --- Upstream notes ---
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
