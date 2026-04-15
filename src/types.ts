// ---------------------------------------------------------------------------
// Shared types for the Swedish Large Cap annual report scraper.
// Core shared interfaces. `DualTrackAdjudication` lives in challenger/types (imported below).
// ---------------------------------------------------------------------------

import type { DualTrackAdjudication } from './challenger/types';

export type { DualTrackAdjudication };

/**
 * Classification used to select extraction heuristics (banks report differently).
 * Auto-detected from document content at runtime — never preconfigured.
 */
export type CompanyType = 'industrial' | 'bank' | 'investment_company' | 'real_estate';

/**
 * Human-reviewed headline values — merged last when automation is untrusted.
 * Optional fields omitted are left unchanged from the pipeline.
 */
export interface ManualHeadlineFields {
  revenue_msek?: number | null;
  ebit_msek?: number | null;
  employees?: number | null;
  ceo?: string | null;
  source?: string;
  reviewedAt?: string;
}

/**
 * Minimal runtime description of one company to scrape.
 * Only `name` is required — everything else is discovered at runtime.
 */
export interface CompanyProfile {
  name: string;
  /** Discovered or provided — the company's main website URL. */
  website?: string;
  /** Stock ticker, if known (e.g. "SEB-A.ST"). */
  ticker?: string;
  /**
   * Canonical legal entity name resolved from data/ticker.json.
   * Used as the primary search term and for allabolag disambiguation.
   */
  legalName?: string;
  /** Swedish org number (e.g. "502032-9081"). Used for direct allabolag lookup. */
  orgNumber?: string;
  /** Multiple candidate domains to try for IR discovery (populated at runtime). */
  candidateDomains?: string[];
  /**
   * Verified investor-relations page URL from data/ticker.json — skips IR discovery when set.
   */
  irPage?: string;
  /** ISIN from ticker.json when present (e.g. for cross-checks or future tooling). */
  isin?: string;
  /** IR contact email from ticker.json when present. */
  irEmail?: string;
  /** Extra strings that may appear in filings (brands, local names) — used for PDF entity check. */
  knownAliases?: string[];
  /** Optional explicit reporting model from ticker map. */
  companyType?: CompanyType;
  /**
   * Curated annual report PDF URLs (highest trust). Tried before discovery.
   * Ordered by preference, newest first.
   */
  annualReportPdfUrls?: string[];
  /** Optional fiscal year expected for override URLs (soft hint only). */
  overrideFiscalYear?: number;
  /** Optional CMS API endpoints returning report metadata / PDFs. */
  cmsApiUrls?: string[];
  /** Optional trusted aggregator page/PDF URLs (e.g. MFN / Nasdaq issuer pages). */
  aggregatorUrls?: string[];
  /** Optional overrides from `data/ticker.json` after manual review. */
  manualHeadlineFields?: ManualHeadlineFields;
}

/** The 4 core financial fields the assignment requires. */
export interface ExtractedData {
  revenue_msek: number | null;
  ebit_msek: number | null;
  employees: number | null;
  ceo: string | null;
  fiscal_year: number | null;
}

export type Scope2Methodology = 'market-based' | 'location-based';

export type SustainabilityConfidence = 'high' | 'medium' | 'low';

/** Sustainability data extracted from annual or standalone sustainability report. */
export interface SustainabilityData {
  reportUrl: string | null;
  reportDownloaded: string | null;
  scope1_co2_tonnes: number | null;
  scope2_co2_tonnes: number | null;
  methodology: Scope2Methodology | null;
  confidence: SustainabilityConfidence | null;
  note: string;
}

/** Outcome of a single pipeline stage. 'partial' = data obtained from a secondary source. */
export type StageStatus = 'success' | 'partial' | 'failed' | 'skipped' | 'not_implemented';

export interface StageResult<T> {
  status: StageStatus;
  value: T | null;
  error?: string;
  durationMs?: number;
}

export type DataSource = 'pdf' | 'allabolag' | 'playwright+pdf' | 'search+pdf' | 'ir-html';
export type ResultStatus = 'complete' | 'partial' | 'failed' | 'timeout';

/** Which fallback step produced the final result. */
export type FallbackStep =
  | 'override'
  | 'search'
  | 'cheerio'
  | 'playwright'
  | 'cms-api'
  | 'direct-pdf-search'
  | 'aggregator'
  | 'ir-html'
  | 'allabolag'
  | 'cached'
  | 'none';

/** One row in the final results.json — one per company, always present even on failure. */
export interface PipelineResult {
  company: string;
  ticker: string | null;
  website: string | null;
  irPage: string | null;
  annualReportUrl: string | null;
  annualReportDownloaded: string | null;
  fiscalYear: number | null;
  extractedData: ExtractedData | null;
  sustainability: SustainabilityData;
  dataSource: DataSource | null;
  confidence: number | null;
  status: ResultStatus;
  fallbackStepReached: FallbackStep;
  detectedCompanyType: CompanyType | null;
  cached: boolean;
  cachedAt?: string;
  extractionNotes: string[];
  /**
   * When `OPENAI_API_KEY` is set and the gate fires, field-level deterministic vs LLM comparison.
   * Omitted when no API key or no PDF text on primary path.
   */
  dualTrackAdjudication?: DualTrackAdjudication;
  /** Internal stage tracking — excluded from output JSON. */
  stages: {
    irDiscovery: StageResult<string>;
    reportDiscovery: StageResult<ReportDiscoveryResult>;
    download: StageResult<string>;
    extraction: StageResult<ExtractedData>;
    validation: StageResult<ExtractedData>;
  };
}

/**
 * `ReportCandidate.source` when the PDF URL came from Playwright (DOM or network).
 * Must match checks in pipeline dataSource assignment.
 */
export const SOURCE_PLAYWRIGHT_FALLBACK = 'fallback-playwright';

/** Source tag for search-engine-discovered PDFs. */
export const SOURCE_SEARCH_DISCOVERY = 'search-discovery';

/** A scored PDF candidate from report discovery. */
export interface ReportCandidate {
  url: string;
  score: number;
  text: string;
  source: string;
}

export type ConfidenceLevel = 'high' | 'medium' | 'low';

/** Result of the report discovery stage. */
export interface ReportDiscoveryResult {
  annualReportUrl: string | null;
  sustainabilityReportUrl: string | null;
  fiscalYear: number | null;
  confidence: ConfidenceLevel;
  explanation: string;
  candidatesConsidered: number;
  allCandidates: ReportCandidate[];
}

/** Runtime configuration assembled from CLI flags + defaults. */
export interface RunConfig {
  companies: CompanyProfile[];
  force: boolean;
  /** When true, sets base delay to 8s for all domains. */
  slow: boolean;
}
