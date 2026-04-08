import type { CompanyType, PipelineResult } from '../types';

export type RiskTier = 'low' | 'medium' | 'high';
export type ConfidenceBand = 'high' | 'medium' | 'low';

export type RiskArchetype =
  | 'js_heavy_ir'
  | 'ambiguous_pdf_corpus'
  | 'layout_fragile_pdf'
  | 'industry_semantic_risk'
  | 'entity_ambiguity'
  | 'cloud_transport_risk';

export interface RiskMapRow {
  ticker: string | null;
  company: string;
  riskScore: number;
  riskTier: RiskTier;
  confidenceBand: ConfidenceBand;
  archetypes: RiskArchetype[];
  signals: string[];
  recommendedAction: string;
  latestStatus: PipelineResult['status'];
  latestConfidence: number | null;
}

export interface RiskMapResponse {
  generatedAt: string | null;
  companyCount: number;
  results: RiskMapRow[];
}

const LOW_MAX = 34;
const MEDIUM_MAX = 64;

function toTier(score: number): RiskTier {
  if (score <= LOW_MAX) return 'low';
  if (score <= MEDIUM_MAX) return 'medium';
  return 'high';
}

function toConfidenceBand(signalCount: number): ConfidenceBand {
  if (signalCount >= 5) return 'high';
  if (signalCount >= 3) return 'medium';
  return 'low';
}

function addArchetype(set: Set<RiskArchetype>, archetype: RiskArchetype): void {
  set.add(archetype);
}

function hasAnyNote(notes: string[], re: RegExp): boolean {
  return notes.some((n) => re.test(n));
}

function countNotes(notes: string[], re: RegExp): number {
  return notes.reduce((acc, n) => acc + (re.test(n) ? 1 : 0), 0);
}

function actionForTierAndArchetypes(tier: RiskTier, archetypes: RiskArchetype[]): string {
  if (tier === 'high') {
    if (archetypes.includes('js_heavy_ir') || archetypes.includes('cloud_transport_risk')) {
      return 'Run cloud preflight scrape and verify Playwright candidate selection.';
    }
    if (archetypes.includes('layout_fragile_pdf')) {
      return 'Review PDF table parsing and add regression test fixture for this layout.';
    }
    return 'Run full cloud validation before exposing this company to clients.';
  }
  if (tier === 'medium') {
    return 'Schedule periodic cloud checks and monitor extractionNotes drift.';
  }
  return 'Low maintenance; include in normal smoke-test rotation.';
}

function scoreCompanyTypeRisk(companyType: CompanyType | null): number {
  if (companyType === 'investment_company') return 10;
  if (companyType === 'real_estate') return 5;
  return 0;
}

export function buildRiskMap(results: PipelineResult[]): RiskMapRow[] {
  const out: RiskMapRow[] = [];

  for (const r of results) {
    const notes = r.extractionNotes ?? [];
    const archetypes = new Set<RiskArchetype>();
    const signals: string[] = [];
    let score = 0;

    if (r.status === 'failed') {
      score += 20;
      signals.push('Latest status is failed.');
    } else if (r.status === 'partial') {
      score += 10;
      signals.push('Latest status is partial.');
    } else if (r.status === 'timeout') {
      score += 25;
      signals.push('Latest status is timeout.');
    }

    if (
      r.fallbackStepReached === 'playwright' ||
      r.fallbackStepReached === 'search' ||
      r.fallbackStepReached === 'allabolag'
    ) {
      score += 15;
      addArchetype(archetypes, 'js_heavy_ir');
      signals.push(`Fallback reached ${r.fallbackStepReached}.`);
    }

    const rejectionCount = countNotes(
      notes,
      /quality gate rejected|rejected .* candidate|rejection summary|revenue-too-high|entity-check/i,
    );
    if (rejectionCount > 0) {
      score += 15;
      addArchetype(archetypes, 'ambiguous_pdf_corpus');
      signals.push(`Candidate rejection pressure detected (${rejectionCount} notes).`);
    }

    if (hasAnyNote(notes, /unit guard|fused year pattern|likely .* misread|suspiciously low/i)) {
      score += 10;
      addArchetype(archetypes, 'layout_fragile_pdf');
      signals.push('Layout/number guards were required.');
    }

    if (hasAnyNote(notes, /fiscal year mismatch/i)) {
      score += 10;
      addArchetype(archetypes, 'entity_ambiguity');
      signals.push('Fiscal year mismatch detected.');
    }

    if (r.confidence !== null && r.confidence < 85) {
      score += 10;
      signals.push(`Confidence below threshold (${r.confidence}%).`);
    }

    const companyTypeRisk = scoreCompanyTypeRisk(r.detectedCompanyType);
    if (companyTypeRisk > 0) {
      score += companyTypeRisk;
      addArchetype(archetypes, 'industry_semantic_risk');
      signals.push(`Company type ${r.detectedCompanyType} has higher semantic extraction risk.`);
    }

    if (hasAnyNote(notes, /entity check failed|ambiguity=high|host collision|no matching company/i)) {
      score += 10;
      addArchetype(archetypes, 'entity_ambiguity');
      signals.push('Entity ambiguity/collision indicators present.');
    }

    if (hasAnyNote(notes, /403|429|download failed|playwright fallback|cloud/i)) {
      score += 8;
      addArchetype(archetypes, 'cloud_transport_risk');
      signals.push('Potential cloud transport/runtime friction observed.');
    }

    const riskScore = Math.max(0, Math.min(100, score));
    const riskTier = toTier(riskScore);
    const signalCount = signals.length;

    out.push({
      ticker: r.ticker,
      company: r.company,
      riskScore,
      riskTier,
      confidenceBand: toConfidenceBand(signalCount),
      archetypes: [...archetypes].sort(),
      signals,
      recommendedAction: actionForTierAndArchetypes(riskTier, [...archetypes]),
      latestStatus: r.status,
      latestConfidence: r.confidence,
    });
  }

  return out.sort(
    (a, b) =>
      b.riskScore - a.riskScore ||
      a.company.localeCompare(b.company, 'sv') ||
      String(a.ticker ?? '').localeCompare(String(b.ticker ?? ''), 'sv'),
  );
}

export function buildRiskMapResponse(
  results: PipelineResult[],
  generatedAt: string | null,
): RiskMapResponse {
  const mapped = buildRiskMap(results);
  return {
    generatedAt,
    companyCount: mapped.length,
    results: mapped,
  };
}
