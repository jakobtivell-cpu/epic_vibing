// ---------------------------------------------------------------------------
// Assignment schema mapping — internal documentation of how native PDF labels
// map to the fixed output fields (revenue_msek, ebit_msek). Output JSON
// shape is unchanged; mapping is reflected in extraction notes and provenance.
// ---------------------------------------------------------------------------

import type { CompanyType } from '../types';

export type MappingBasis = 'exact' | 'mapped' | 'unsupported' | 'n_a';

export interface FieldSchemaMapping {
  assignmentField: 'revenue_msek' | 'ebit_msek';
  nativeLabelMatched: string | null;
  basis: MappingBasis;
  explanation: string;
}

const BANK_REV_MAPPED = [
  'summa rörelseintäkter',
  'total operating income',
  'totala rörelseintäkter',
  'net interest income',
  'räntenetto',
  'total income',
];

const INDUSTRIAL_REV_EXACT = [
  'net sales',
  'nettoomsättning',
  'revenue',
  'omsättning',
  'total revenue',
];

/**
 * Classify how a matched label maps to the assignment field for the reporting model.
 */
export function classifyRevenueMapping(
  detectedType: CompanyType,
  matchedLabel: string | null,
): FieldSchemaMapping {
  const label = (matchedLabel ?? '').toLowerCase();
  if (detectedType === 'investment_company') {
    return {
      assignmentField: 'revenue_msek',
      nativeLabelMatched: matchedLabel,
      basis: 'n_a',
      explanation: 'Investment company — revenue field not mapped to industrial revenue',
    };
  }
  if (detectedType === 'bank') {
    const isBankNative = BANK_REV_MAPPED.some((p) => label.includes(p));
    return {
      assignmentField: 'revenue_msek',
      nativeLabelMatched: matchedLabel,
      basis: isBankNative ? 'mapped' : 'mapped',
      explanation: isBankNative
        ? `Bank: assignment revenue_msek derived from native line "${matchedLabel}" (operating-income family, not industrial net sales)`
        : `Bank: assignment revenue_msek from "${matchedLabel}" — verify against annual report definitions`,
    };
  }
  const exact = INDUSTRIAL_REV_EXACT.some((p) => label.includes(p));
  return {
    assignmentField: 'revenue_msek',
    nativeLabelMatched: matchedLabel,
    basis: exact ? 'exact' : 'mapped',
    explanation: exact
      ? 'Industrial: revenue aligned with net sales / nettoomsättning family'
      : 'Industrial: revenue from label outside primary list — treated as approximate',
  };
}

export function classifyEbitMapping(
  detectedType: CompanyType,
  matchedLabel: string | null,
): FieldSchemaMapping {
  const label = (matchedLabel ?? '').toLowerCase();
  if (detectedType === 'investment_company') {
    return {
      assignmentField: 'ebit_msek',
      nativeLabelMatched: matchedLabel,
      basis: 'n_a',
      explanation: 'Investment company — EBIT may not apply',
    };
  }
  if (detectedType === 'bank') {
    const fragile = /\b(before tax|före skatt|impairment|credit loss)\b/i.test(label);
    return {
      assignmentField: 'ebit_msek',
      nativeLabelMatched: matchedLabel,
      basis: fragile ? 'mapped' : 'mapped',
      explanation: fragile
        ? `Bank: EBIT assignment from "${matchedLabel}" — may differ from industrial EBIT; confirm in report`
        : `Bank: operating result mapped to ebit_msek from "${matchedLabel}"`,
    };
  }
  return {
    assignmentField: 'ebit_msek',
    nativeLabelMatched: matchedLabel,
    basis: 'exact',
    explanation: 'Industrial: operating profit / rörelseresultat family',
  };
}

export function formatMappingNotes(mappings: FieldSchemaMapping[]): string[] {
  return mappings.map(
    (m) =>
      `SCHEMA_MAP[${m.assignmentField}] basis=${m.basis} native="${m.nativeLabelMatched ?? ''}" — ${m.explanation}`,
  );
}
