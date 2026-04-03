// ---------------------------------------------------------------------------
// Shared types for the Swedish Large Cap annual report scraper.
// Every module imports from here — no circular deps.
// ---------------------------------------------------------------------------

/** Classification used to select extraction heuristics (banks report differently). */
export type CompanyType = 'industrial' | 'bank' | 'investment_company';

/**
 * A runtime description of one company to scrape.
 * The pipeline is fully company-agnostic — all company-specific knowledge
 * lives in this profile object.
 */
export interface CompanyProfile {
  name: string;
  ticker: string;
  website: string;
  /** Path fragments to try when discovering the IR page (e.g. "/en/investors"). */
  irHints: string[];
  companyType: CompanyType;
  /** Alternative names the company may appear as in reports or page titles. */
  knownAliases: string[];
  /** Human-readable warnings about common confusion or fragile assumptions. */
  entityWarnings: string[];
  /** Swedish org number (e.g. "556012-5790"). Used for allabolag.se data fallback. */
  orgNumber?: string;
}

/** The 4 core financial fields the assignment requires. */
export interface ExtractedData {
  revenue_msek: number | null;
  ebit_msek: number | null;
  employees: number | null;
  ceo: string | null;
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

export type DataSource = 'pdf' | 'allabolag' | 'playwright+pdf';
export type ResultStatus = 'complete' | 'partial' | 'failed';

/** One row in the final results.json — one per company, always present even on failure. */
export interface PipelineResult {
  company: string;
  ticker: string;
  website: string;
  irPage: string | null;
  annualReportUrl: string | null;
  annualReportDownloaded: string | null;
  fiscalYear: number | null;
  extractedData: ExtractedData | null;
  sustainability: SustainabilityData;
  dataSource: DataSource | null;
  confidence: number | null;
  status: ResultStatus;
  extractionNotes: string[];
  /** Internal stage tracking — excluded from output JSON. */
  stages: {
    irDiscovery: StageResult<string>;
    reportDiscovery: StageResult<ReportDiscoveryResult>;
    download: StageResult<string>;
    extraction: StageResult<ExtractedData>;
    validation: StageResult<ExtractedData>;
  };
}

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
  failedOnly: boolean;
  ticker?: string;
}
