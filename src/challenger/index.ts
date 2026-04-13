// ---------------------------------------------------------------------------
// LLM challenger orchestrator — conditional run, dual-track adjudication.
// ---------------------------------------------------------------------------

import type { ExtractedData, CompanyType, ResultStatus } from '../types';
import type { FieldExtractionResult, FieldProvenance } from '../extraction/field-extractor';
import { createLogger } from '../utils/logger';
import { buildLlmContextWindows } from './evidence';
import { shouldRunLlmChallenger, type ChallengerGateInput } from './gate';
import {
  runLlmExtraction,
  runLlmEbitRepair,
  shouldUseNarrowEbitLlmRepair,
} from './llm-extract';
import { adjudicateDualTrack, errorAdjudication } from './adjudicate';
import type { DualTrackAdjudication } from './types';

const log = createLogger('challenger');

export type { DualTrackAdjudication, FieldAdjudication, FieldEvidence } from './types';

export interface RunChallengerParams {
  companyDisplayName: string;
  legalNameForPrompt: string;
  ticker: string | null;
  fullPdfText: string;
  pageCount: number;
  suspiciouslyShortPdf: boolean;
  /** Post-validation deterministic row (primary pipeline output). */
  validatedData: ExtractedData;
  deterministicFiscalYear: number | null;
  /** Raw field extraction (provenance); null for IR HTML / allabolag-only paths. */
  fieldExtraction: FieldExtractionResult | null;
  confidence: number | null;
  status: ResultStatus;
  detectedCompanyType: CompanyType | null;
  forceLlm: boolean;
  /** Pipeline extraction notes — narrow EBIT LLM repair when validator discarded EBIT. */
  extractionNotes?: string[];
}

/**
 * Returns null when OPENAI_API_KEY is unset — no dual-track payload (keeps JSON small).
 * When key is set but the gate declines, returns adjudication with ranLlm:false.
 */
export async function runChallengerTrack(params: RunChallengerParams): Promise<DualTrackAdjudication | null> {
  const hasKey = Boolean(process.env.OPENAI_API_KEY?.trim());
  if (!hasKey) {
    return null;
  }

  const gateInput: ChallengerGateInput = {
    hasPdfText: params.fullPdfText.length > 0,
    suspiciouslyShortPdf: params.suspiciouslyShortPdf,
    confidence: params.confidence,
    status: params.status,
    extractedData: params.validatedData,
    fiscalYear: params.deterministicFiscalYear,
    companyName: params.companyDisplayName,
    ticker: params.ticker,
    detectedCompanyType: params.detectedCompanyType,
    forceLlm: params.forceLlm,
  };

  if (!shouldRunLlmChallenger(gateInput, true)) {
    log.debug(`[${params.companyDisplayName}] LLM challenger skipped by gate`);
    return null;
  }

  const context = buildLlmContextWindows(params.fullPdfText);
  const narrowEbit = shouldUseNarrowEbitLlmRepair(
    params.validatedData,
    params.extractionNotes,
  );

  let llmResult = narrowEbit
    ? await runLlmEbitRepair(params.legalNameForPrompt, params.fullPdfText, context)
    : await runLlmExtraction(params.legalNameForPrompt, params.fullPdfText, context);

  const narrowAccepted =
    llmResult.ok &&
    llmResult.evidences.ebit_msek.quoteOk &&
    llmResult.evidences.ebit_msek.evidence !== null &&
    typeof llmResult.evidences.ebit_msek.evidence.value === 'number';

  if (narrowEbit && (!narrowAccepted || !llmResult.ok)) {
    log.debug(
      `[${params.companyDisplayName}] Narrow EBIT repair inconclusive — falling back to full LLM extract`,
    );
    llmResult = await runLlmExtraction(
      params.legalNameForPrompt,
      params.fullPdfText,
      context,
    );
  }

  if (!llmResult.ok) {
    log.warn(`[${params.companyDisplayName}] LLM challenger failed: ${llmResult.error}`);
    return errorAdjudication(llmResult.error);
  }

  const provenance: {
    revenue: FieldProvenance | null;
    ebit: FieldProvenance | null;
    employees: FieldProvenance | null;
    ceo: FieldProvenance | null;
  } = params.fieldExtraction
    ? params.fieldExtraction.provenance
    : { revenue: null, ebit: null, employees: null, ceo: null };

  return adjudicateDualTrack({
    deterministicData: params.validatedData,
    deterministicFiscalYear: params.deterministicFiscalYear,
    provenance,
    fullText: params.fullPdfText,
    pageCount: Math.max(1, params.pageCount),
    companyType: params.detectedCompanyType ?? 'industrial',
    llm: llmResult,
  });
}
