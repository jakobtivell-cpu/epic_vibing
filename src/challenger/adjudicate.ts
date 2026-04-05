// ---------------------------------------------------------------------------
// Field-by-field adjudication — deterministic vs LLM; conservative acceptance.
// ---------------------------------------------------------------------------

import type { ExtractedData, CompanyType } from '../types';
import { validateExtractedData } from '../validation/validator';
import type { FieldProvenance } from '../extraction/field-extractor';
import { clipSnippet, collapseWs, deterministicNormalizationNotes, estimatePageFromSnippet } from './evidence';
import type {
  AdjudicationFieldKey,
  DualTrackAdjudication,
  FieldAdjudication,
  FieldEvidence,
} from './types';
import type { LlmExtractResult } from './llm-extract';

const FY_MIN = 2020;
const FY_MAX = 2031;

function nearEqual(a: number, b: number, rel = 0.005): boolean {
  if (a === b) return true;
  const denom = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / denom <= rel;
}

function buildDeterministicEvidence(
  field: AdjudicationFieldKey,
  value: number | string | null,
  prov: FieldProvenance | null,
  fullText: string,
  pageCount: number,
): FieldEvidence | null {
  if (value === null && !prov) return null;
  const snippet = clipSnippet(prov?.rawSnippet ?? (value !== null ? String(value) : null));
  const page =
    snippet && pageCount > 0 ? estimatePageFromSnippet(fullText, snippet, pageCount) : null;
  return {
    track: 'deterministic',
    value,
    page,
    sourceTextSnippet: snippet,
    normalizationApplied: deterministicNormalizationNotes(
      field === 'fiscalYear' ? 'fiscalYear' : field,
      prov,
    ),
  };
}

function validateFiscalYear(y: number | null): boolean {
  if (y === null) return false;
  return y >= FY_MIN && y <= FY_MAX;
}

/** True if this value survives pipeline validation when merged into the full row. */
function valueSurvivesValidation(
  field: 'revenue_msek' | 'ebit_msek' | 'employees',
  val: number,
  base: ExtractedData,
  companyType: CompanyType,
): boolean {
  const merged: ExtractedData = { ...base, [field]: val };
  const v = validateExtractedData(merged, companyType, []);
  if (field === 'revenue_msek') return v.data.revenue_msek === val;
  if (field === 'ebit_msek') return v.data.ebit_msek === val;
  return v.data.employees === val;
}

function ceoMatch(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  return collapseWs(a).toLowerCase() === collapseWs(b).toLowerCase();
}

function llmQuoteStrength(snippet: string | null): 'strong' | 'weak' | 'none' {
  if (!snippet || snippet.length < 12) return 'none';
  if (snippet.length >= 48) return 'strong';
  return 'weak';
}

function adjudicateNumeric(
  field: 'revenue_msek' | 'ebit_msek' | 'employees',
  det: FieldEvidence | null,
  llm: FieldEvidence | null,
  llmQuoteOk: boolean,
  companyType: CompanyType,
  baseData: ExtractedData,
): FieldAdjudication {
  const dv = det?.value;
  const lv = llm?.value;
  const dNum = typeof dv === 'number' ? dv : null;
  const lNum = typeof lv === 'number' ? lv : null;

  const detValid = dNum !== null && valueSurvivesValidation(field, dNum, baseData, companyType);
  const llmValid =
    lNum !== null && llmQuoteOk && valueSurvivesValidation(field, lNum, baseData, companyType);

  const llmForAudit = lNum !== null ? llm : null;

  if (dNum !== null && lNum !== null && llmQuoteOk) {
    const match =
      field === 'employees' ? dNum === lNum : nearEqual(dNum, lNum, field === 'ebit_msek' ? 0.01 : 0.005);
    if (match && detValid) {
      return {
        finalValue: dNum,
        status: 'accepted',
        acceptedTrack: 'deterministic',
        deterministic: det,
        llm: llmForAudit,
        reason: 'Deterministic and LLM agree after normalization; primary track kept',
      };
    }
    if (match && !detValid && llmValid) {
      return {
        finalValue: lNum,
        status: 'accepted',
        acceptedTrack: 'llm',
        deterministic: det,
        llm: llmForAudit,
        reason: 'Values agree; deterministic failed validation, LLM passed with verified quote',
      };
    }
    if (match && !detValid && !llmValid) {
      return {
        finalValue: null,
        status: 'needs_review',
        acceptedTrack: 'none',
        deterministic: det,
        llm: llmForAudit,
        reason: 'Values agree but neither track passes validation',
      };
    }
    if (!match) {
      const llmStrong = llmValid && llmQuoteStrength(llm?.sourceTextSnippet ?? null) === 'strong';
      const detStrong = detValid && det?.sourceTextSnippet && det.sourceTextSnippet.length >= 20;
      if (llmStrong && !detStrong) {
        return {
          finalValue: lNum,
          status: 'accepted',
          acceptedTrack: 'llm',
          deterministic: det,
          llm: llmForAudit,
          reason: 'Disagreement: LLM has stronger verified evidence and passes validation',
        };
      }
      if (detStrong && !llmStrong) {
        return {
          finalValue: dNum,
          status: 'accepted',
          acceptedTrack: 'deterministic',
          deterministic: det,
          llm: llmForAudit,
          reason: 'Disagreement: deterministic evidence stronger; LLM mismatch or weak quote',
        };
      }
      return {
        finalValue: null,
        status: 'needs_review',
        acceptedTrack: 'none',
        deterministic: det,
        llm: llmForAudit,
        reason: 'Deterministic vs LLM disagree; no automatic winner',
      };
    }
  }

  if (dNum !== null && lNum !== null && !llmQuoteOk) {
    if (detValid) {
      return {
        finalValue: dNum,
        status: 'accepted',
        acceptedTrack: 'deterministic',
        deterministic: det,
        llm: llmForAudit,
        reason: 'LLM quote not verified in document; kept deterministic',
      };
    }
    return {
      finalValue: null,
      status: 'needs_review',
      acceptedTrack: 'none',
      deterministic: det,
      llm: llmForAudit,
      reason: 'LLM unverified; deterministic fails validation',
    };
  }

  if (dNum !== null && detValid && (lNum === null || !llmQuoteOk)) {
    return {
      finalValue: dNum,
      status: 'accepted',
      acceptedTrack: 'deterministic',
      deterministic: det,
      llm: llmForAudit,
      reason: 'Deterministic value only (LLM absent or unverified)',
    };
  }

  if (lNum !== null && llmValid && llmQuoteOk && dNum === null) {
    return {
      finalValue: lNum,
      status: 'accepted',
      acceptedTrack: 'llm',
      deterministic: det,
      llm: llmForAudit,
      reason: 'LLM filled missing field with verified quote and validation passed',
    };
  }

  if (lNum !== null && llmQuoteOk && !llmValid && dNum !== null && detValid) {
    return {
      finalValue: dNum,
      status: 'accepted',
      acceptedTrack: 'deterministic',
      deterministic: det,
      llm: llmForAudit,
      reason: 'LLM value failed validation; kept deterministic',
    };
  }

  return {
    finalValue: null,
    status: dNum === null && lNum === null ? 'failed' : 'needs_review',
    acceptedTrack: 'none',
    deterministic: det,
    llm: llmForAudit,
    reason: 'Insufficient verified evidence for automatic acceptance',
  };
}

function adjudicateCeo(
  det: FieldEvidence | null,
  llm: FieldEvidence | null,
  llmQuoteOk: boolean,
  _fullText: string,
): FieldAdjudication {
  const dv = typeof det?.value === 'string' ? det.value : null;
  const lv = typeof llm?.value === 'string' ? llm.value : null;

  const llmOk = Boolean(lv && llmQuoteOk && llm?.sourceTextSnippet);
  const llmForAudit = lv ? llm : null;

  if (dv && lv && ceoMatch(dv, lv)) {
    return {
      finalValue: dv,
      status: 'accepted',
      acceptedTrack: 'deterministic',
      deterministic: det,
      llm: llmForAudit,
      reason: 'CEO strings match; primary track kept',
    };
  }

  if (dv && !lv) {
    return {
      finalValue: dv,
      status: 'accepted',
      acceptedTrack: 'deterministic',
      deterministic: det,
      llm: null,
      reason: 'CEO from deterministic path only',
    };
  }

  if (lv && llmOk && !dv) {
    const strong = llmQuoteStrength(llm?.sourceTextSnippet ?? null) === 'strong';
    return {
      finalValue: lv,
      status: strong ? 'accepted' : 'needs_review',
      acceptedTrack: strong ? 'llm' : 'none',
      deterministic: det,
      llm: llmForAudit,
      reason: strong
        ? 'CEO from LLM with strong verified quote'
        : 'CEO from LLM but quote short — manual review',
    };
  }

  if (dv && lv && !ceoMatch(dv, lv)) {
    return {
      finalValue: null,
      status: 'needs_review',
      acceptedTrack: 'none',
      deterministic: det,
      llm: llmForAudit,
      reason: 'CEO mismatch between tracks',
    };
  }

  return {
    finalValue: null,
    status: 'failed',
    acceptedTrack: 'none',
    deterministic: det,
    llm: llmForAudit,
    reason: 'CEO not extracted',
  };
}

function adjudicateFiscalYear(
  det: FieldEvidence | null,
  llm: FieldEvidence | null,
  llmQuoteOk: boolean,
): FieldAdjudication {
  const dNum = typeof det?.value === 'number' ? det.value : null;
  const lNum = typeof llm?.value === 'number' ? llm.value : null;
  const dOk = validateFiscalYear(dNum);
  const lOk = validateFiscalYear(lNum) && llmQuoteOk;

  if (dNum !== null && lNum !== null && dNum === lNum && dOk) {
    return {
      finalValue: dNum,
      status: 'accepted',
      acceptedTrack: 'deterministic',
      deterministic: det,
      llm: llmQuoteOk ? llm : null,
      reason: 'Fiscal year agrees; explicit evidence required for LLM — matched',
    };
  }

  if (dOk && !lOk) {
    return {
      finalValue: dNum,
      status: 'accepted',
      acceptedTrack: 'deterministic',
      deterministic: det,
      llm: llmQuoteOk ? llm : null,
      reason: 'Fiscal year from deterministic extractor',
    };
  }

  if (lOk && !dOk) {
    return {
      finalValue: lNum,
      status: 'accepted',
      acceptedTrack: 'llm',
      deterministic: det,
      llm,
      reason: 'Fiscal year from LLM with explicit year quote in document',
    };
  }

  if (dNum !== null && lNum !== null && dNum !== lNum) {
    return {
      finalValue: null,
      status: 'needs_review',
      acceptedTrack: 'none',
      deterministic: det,
      llm: llmQuoteOk ? llm : null,
      reason: 'Fiscal year conflict',
    };
  }

  return {
    finalValue: null,
    status: 'failed',
    acceptedTrack: 'none',
    deterministic: det,
    llm: llmQuoteOk ? llm : null,
    reason: 'Fiscal year not established with explicit evidence',
  };
}

export interface AdjudicateInput {
  deterministicData: ExtractedData;
  deterministicFiscalYear: number | null;
  provenance: {
    revenue: FieldProvenance | null;
    ebit: FieldProvenance | null;
    employees: FieldProvenance | null;
    ceo: FieldProvenance | null;
  };
  fullText: string;
  pageCount: number;
  companyType: CompanyType;
  llm: LlmExtractResult;
}

export function adjudicateDualTrack(input: AdjudicateInput): DualTrackAdjudication {
  const { deterministicData: d, provenance: p, fullText, pageCount, companyType, llm } = input;

  const detRev = buildDeterministicEvidence(
    'revenue_msek',
    d.revenue_msek,
    p.revenue,
    fullText,
    pageCount,
  );
  const detEbit = buildDeterministicEvidence('ebit_msek', d.ebit_msek, p.ebit, fullText, pageCount);
  const detEmp = buildDeterministicEvidence(
    'employees',
    d.employees,
    p.employees,
    fullText,
    pageCount,
  );
  const detCeo = buildDeterministicEvidence('ceo', d.ceo, p.ceo, fullText, pageCount);
  const detFy = buildDeterministicEvidence(
    'fiscalYear',
    input.deterministicFiscalYear,
    null,
    fullText,
    pageCount,
  );

  const q = (k: keyof LlmExtractResult['evidences']) => {
    const block = llm.evidences[k];
    const ok = block.quoteOk && block.evidence !== null;
    return { ev: ok ? block.evidence : null, quoteOk: block.quoteOk };
  };

  const r = q('revenue_msek');
  const e = q('ebit_msek');
  const em = q('employees');
  const c = q('ceo');
  const fy = q('fiscalYear');

  const fields = {
    revenue_msek: adjudicateNumeric(
      'revenue_msek',
      detRev,
      r.ev,
      r.quoteOk,
      companyType,
      d,
    ),
    ebit_msek: adjudicateNumeric('ebit_msek', detEbit, e.ev, e.quoteOk, companyType, d),
    employees: adjudicateNumeric('employees', detEmp, em.ev, em.quoteOk, companyType, d),
    ceo: adjudicateCeo(detCeo, c.ev, c.quoteOk, fullText),
    fiscalYear: adjudicateFiscalYear(detFy, fy.ev, fy.quoteOk),
  } satisfies Record<AdjudicationFieldKey, FieldAdjudication>;

  return {
    ranLlm: true,
    skipReason: null,
    llmError: null,
    fields,
  };
}

export function emptyAdjudication(skipReason: string): DualTrackAdjudication {
  const failed = (reason: string): FieldAdjudication => ({
    finalValue: null,
    status: 'failed',
    acceptedTrack: 'none',
    deterministic: null,
    llm: null,
    reason,
  });
  return {
    ranLlm: false,
    skipReason,
    llmError: null,
    fields: {
      revenue_msek: failed('LLM challenger not run'),
      ebit_msek: failed('LLM challenger not run'),
      employees: failed('LLM challenger not run'),
      ceo: failed('LLM challenger not run'),
      fiscalYear: failed('LLM challenger not run'),
    },
  };
}

export function errorAdjudication(message: string): DualTrackAdjudication {
  const base = emptyAdjudication('LLM call failed');
  return { ...base, ranLlm: true, llmError: message, skipReason: null };
}
