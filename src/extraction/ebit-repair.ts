// ---------------------------------------------------------------------------
// Pre-validation EBIT reconciliation — unit rescale + consolidated second pass.
// Runs after deterministic extraction and before validateExtractedData.
// ---------------------------------------------------------------------------

import type { ReportingModelHint } from '../entity/entity-profile';
import type { ExtractedData, CompanyType } from '../types';
import type { FieldExtractionResult } from './field-extractor';
import {
  extractEbitSecondPassFromIncomeSections,
  resolveCompanyTypeForExtraction,
} from './field-extractor';

export interface EbitRepairContext {
  pdfText: string | null;
  fiscalYear: number | null;
  reportingModelHint: ReportingModelHint;
  fieldExtraction: FieldExtractionResult | null;
}

function skipScaleForRealEstateFörvalt(notes: string[]): boolean {
  return notes.some(
    (n) =>
      n.includes('förvaltningsresultat') && n.includes('primary operating metric'),
  );
}

function tryRescaleEbitVersusRevenue(
  ebit: number,
  revenue: number,
  companyType: CompanyType,
): { ebit: number; divisor: number } | null {
  if (revenue <= 0 || !Number.isFinite(ebit) || !Number.isFinite(revenue)) return null;
  if (ebit <= revenue) return null;

  if (companyType === 'bank') {
    const ratio = ebit / revenue;
    const absDelta = ebit - revenue;
    if (ratio <= 1.3 && absDelta <= 15_000) return null;
  } else if (companyType === 'real_estate') {
    if (ebit / revenue < 1.5) return null;
  } else {
    if (ebit / revenue < 1.5) return null;
  }

  for (const divisor of [1000, 100, 10]) {
    const adj = Math.round(ebit / divisor);
    if (Math.abs(adj) > Math.abs(revenue) * 1.02 + 1) continue;
    if (revenue >= 5000 && Math.abs(adj) > 0 && Math.abs(adj) < 50) continue;
    return { ebit: adj, divisor };
  }
  return null;
}

export function repairEbitBeforeValidation(
  data: ExtractedData,
  companyType: CompanyType,
  pipelineNotes: string[],
  ctx: EbitRepairContext,
): { data: ExtractedData; notes: string[] } {
  const notes: string[] = [];
  if (companyType === 'investment_company') {
    return { data: { ...data }, notes };
  }

  let d: ExtractedData = { ...data };

  const rawEbit = ctx.fieldExtraction?.provenance.ebit?.rawSnippet ?? '';
  if (
    d.ebit_msek !== null &&
    d.revenue_msek !== null &&
    d.ebit_msek > d.revenue_msek &&
    /\btkr\b|\bksek\b/i.test(rawEbit)
  ) {
    const adj = Math.round(d.ebit_msek / 1000);
    if (Math.abs(adj) <= Math.abs(d.revenue_msek) * 1.02 + 1) {
      notes.push(
        `Pre-validation EBIT repair: ÷1000 (KSEK/tkr hint in snippet "${rawEbit.slice(0, 100).trim()}")`,
      );
      d = { ...d, ebit_msek: adj };
    }
  }

  if (
    d.ebit_msek !== null &&
    d.revenue_msek !== null &&
    d.ebit_msek > d.revenue_msek &&
    !(companyType === 'real_estate' && skipScaleForRealEstateFörvalt(pipelineNotes))
  ) {
    const scaled = tryRescaleEbitVersusRevenue(d.ebit_msek, d.revenue_msek, companyType);
    if (scaled) {
      notes.push(
        `Pre-validation EBIT repair: ÷${scaled.divisor} (revenue vs EBIT scale reconciliation)`,
      );
      d = { ...d, ebit_msek: scaled.ebit };
    }
  }

  const needsSecondPass =
    Boolean(ctx.pdfText) &&
    (d.ebit_msek === null ||
      (d.revenue_msek !== null && d.ebit_msek !== null && d.ebit_msek > d.revenue_msek));

  if (needsSecondPass && ctx.pdfText) {
    const hintForResolve =
      ctx.reportingModelHint === 'unspecified' ? null : ctx.reportingModelHint;
    const typeForSecond = resolveCompanyTypeForExtraction(ctx.pdfText, hintForResolve);

    const sp = extractEbitSecondPassFromIncomeSections(
      ctx.pdfText,
      typeForSecond,
      ctx.fiscalYear,
      d.revenue_msek,
    );
    for (const n of sp.notes) {
      notes.push(n);
    }
    if (sp.ebit_msek !== null) {
      const replace =
        d.ebit_msek === null ||
        (d.revenue_msek !== null && d.ebit_msek !== null && d.ebit_msek > d.revenue_msek);
      if (replace) {
        d = { ...d, ebit_msek: sp.ebit_msek };
      }
    }
  }

  return { data: d, notes };
}
