// ---------------------------------------------------------------------------
// Dual-track (deterministic vs LLM) adjudication types — audit-friendly.
// ---------------------------------------------------------------------------

export type AdjudicationFieldKey =
  | 'revenue_msek'
  | 'ebit_msek'
  | 'employees'
  | 'ceo'
  | 'fiscalYear';

export type FieldAcceptedTrack = 'deterministic' | 'llm' | 'none';

export type FieldAdjudicationStatus = 'accepted' | 'needs_review' | 'failed';

/** Evidence bundle for one track and one field. */
export interface FieldEvidence {
  track: 'deterministic' | 'llm';
  /** Normalized value used for comparison (MSEK, headcount, name string, or fiscal year). */
  value: number | string | null;
  /** Best-effort page (1-based); null if unknown. */
  page: number | null;
  /** Verbatim or near-verbatim excerpt from the annual report (may be empty for deterministic table rows). */
  sourceTextSnippet: string | null;
  /** Human-readable normalization steps (units, scale, separators). */
  normalizationApplied: string[];
}

/** Per-field adjudication outcome. */
export interface FieldAdjudication {
  finalValue: number | string | null;
  status: FieldAdjudicationStatus;
  acceptedTrack: FieldAcceptedTrack;
  deterministic: FieldEvidence | null;
  llm: FieldEvidence | null;
  reason: string;
}

export interface DualTrackAdjudication {
  ranLlm: boolean;
  /** Set when the LLM call was skipped (no API key, gate, or no PDF text). */
  skipReason: string | null;
  /** Populated when the LLM HTTP/API layer failed. */
  llmError: string | null;
  fields: Record<AdjudicationFieldKey, FieldAdjudication>;
}
