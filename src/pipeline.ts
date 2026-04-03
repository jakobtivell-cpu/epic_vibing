// ---------------------------------------------------------------------------
// Pipeline orchestrator — runs each stage in sequence per company.
// Stages: IR discovery → report discovery → download → extraction → validation
// Bonus: sustainability report discovery + CO2 extraction
// Fallback: allabolag.se data extraction when no PDF is available.
// ---------------------------------------------------------------------------

import {
  CompanyProfile,
  PipelineResult,
  StageResult,
  ExtractedData,
  ReportDiscoveryResult,
  SustainabilityData,
  DataSource,
  ResultStatus,
} from './types';
import { INTER_COMPANY_DELAY_MS } from './config/settings';
import { discoverIrPage, discoverAnnualReport } from './discovery';
import { downloadPdf } from './download';
import { extractTextFromPdf, extractFields, extractFromAllabolag } from './extraction';
import { extractSustainabilityData } from './extraction/sustainability-extractor';
import {
  validateExtractedData,
  verifyEntityInPdf,
  verifyAnnualReportContent,
  crossValidateFiscalYear,
} from './validation';
import { createLogger } from './utils/logger';

const log = createLogger('pipeline');
const CURRENT_YEAR = new Date().getFullYear();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the full pipeline for a list of companies.
 * Every company gets a result row, even if stages fail.
 */
export async function runPipeline(
  companies: CompanyProfile[],
  force: boolean,
): Promise<PipelineResult[]> {
  const results: PipelineResult[] = [];

  for (let i = 0; i < companies.length; i++) {
    const company = companies[i];

    log.info(
      `Processing ${company.name} (${company.ticker}) [${i + 1}/${companies.length}]`,
    );

    const result = await processCompany(company, force);
    results.push(result);

    if (i < companies.length - 1) {
      log.debug(
        `Waiting ${INTER_COMPANY_DELAY_MS}ms before next company`,
      );
      await sleep(INTER_COMPANY_DELAY_MS);
    }
  }

  return results;
}

function nullSustainability(note: string): SustainabilityData {
  return {
    reportUrl: null,
    reportDownloaded: null,
    scope1_co2_tonnes: null,
    scope2_co2_tonnes: null,
    methodology: null,
    confidence: null,
    note,
  };
}

function determineStatus(data: ExtractedData | null): ResultStatus {
  if (!data) return 'failed';
  const fields = [data.revenue_msek, data.ebit_msek, data.employees, data.ceo];
  const nonNull = fields.filter((f) => f !== null).length;
  if (nonNull === 4) return 'complete';
  if (nonNull > 0) return 'partial';
  return 'failed';
}

function validateFiscalYear(
  year: number | null,
  notes: string[],
): number | null {
  if (year === null) {
    notes.push('Fiscal year not extracted');
    return null;
  }
  if (year < CURRENT_YEAR - 3 || year > CURRENT_YEAR + 1) {
    notes.push(`Fiscal year ${year} seems wrong — discarded`);
    return null;
  }
  return year;
}

async function processCompany(
  company: CompanyProfile,
  force: boolean,
): Promise<PipelineResult> {
  const notes: string[] = [];

  const skipped: StageResult<never> = {
    status: 'skipped',
    value: null,
    error: 'Skipped because a prior stage did not succeed',
  };

  // Stage 1: IR page discovery
  const irResult = await discoverIrPage(company);

  // Stage 2: Annual report PDF discovery (also detects sustainability report)
  let reportResult: StageResult<ReportDiscoveryResult>;
  if (irResult.status === 'success' && irResult.value) {
    reportResult = await discoverAnnualReport(company, irResult.value);
  } else {
    reportResult = skipped;
  }

  const reportUrl = reportResult.value?.annualReportUrl ?? null;
  const sustainReportUrl = reportResult.value?.sustainabilityReportUrl ?? null;
  const discoveryFiscalYear = reportResult.value?.fiscalYear ?? null;

  // Stage 3: PDF download
  let downloadResult: StageResult<string>;
  if (reportResult.status === 'success' && reportUrl) {
    downloadResult = await downloadPdf(reportUrl, company.ticker, discoveryFiscalYear, force);
  } else {
    downloadResult = skipped;
  }

  // Stage 4: Text extraction + field extraction
  let extractionResult: StageResult<ExtractedData>;
  let dataSource: DataSource | null = null;
  let fiscalYear: number | null = null;
  let annualReportText: string | null = null;

  if (downloadResult.status === 'success' && downloadResult.value) {
    const start = Date.now();
    const pdfText = await extractTextFromPdf(downloadResult.value, {
      ticker: company.ticker,
      fiscalYear: discoveryFiscalYear,
    });

    if (pdfText.text) {
      annualReportText = pdfText.text;
      if (pdfText.suspiciouslyShort) {
        notes.push(`PDF text suspiciously short (${pdfText.textLength} chars / ${pdfText.pageCount} pages) — may be scanned`);
      }

      // Post-download gate 1: entity verification
      const entityCheck = verifyEntityInPdf(annualReportText, company);
      if (!entityCheck.passed) {
        notes.push(`ENTITY WARNING: company name/aliases not found in first 2 pages of PDF — may be wrong company's report`);
      }

      // Post-download gate 2: content type verification
      const contentCheck = verifyAnnualReportContent(annualReportText);
      for (const w of contentCheck.warnings) {
        notes.push(w);
      }
      if (contentCheck.isQuarterlyReport) {
        notes.push('CONTENT WARNING: PDF is likely a quarterly report — extraction results may be for a single quarter');
      }

      const extraction = extractFields(annualReportText, company, discoveryFiscalYear);
      extractionResult = {
        status: 'success',
        value: extraction.data,
        durationMs: Date.now() - start,
      };
      fiscalYear = extraction.fiscalYear;

      // Merge extraction notes and log provenance
      for (const n of extraction.notes) {
        notes.push(n);
      }
      for (const [field, prov] of Object.entries(extraction.provenance)) {
        if (prov) {
          log.debug(
            `Provenance [${field}]: label="${prov.matchedLabel}" context=${prov.context} line=${prov.lineIndex} raw="${prov.rawSnippet}"`,
          );
        }
      }

      // Determine dataSource based on how the report was discovered
      const winnerSource = reportResult.value?.allCandidates?.find(
        (c) => c.url === reportUrl,
      )?.source;
      dataSource = winnerSource === 'playwright-fallback' ? 'playwright+pdf' : 'pdf';
    } else {
      log.error(`Text extraction failed for ${company.name}: ${pdfText.extractionError}`);
      extractionResult = {
        status: 'failed',
        value: null,
        error: `Text extraction failed: ${pdfText.extractionError}`,
        durationMs: Date.now() - start,
      };
    }
  } else {
    extractionResult = skipped;
  }

  // Allabolag fallback — fires when no PDF extraction succeeded
  if (extractionResult.status !== 'success' && company.orgNumber) {
    log.info(
      `${company.name}: no PDF data — trying allabolag.se as data fallback`,
    );
    const start = Date.now();
    const allabolagResult = await extractFromAllabolag(company);

    if (allabolagResult) {
      extractionResult = {
        status: 'partial',
        value: allabolagResult.data,
        error: allabolagResult.explanation,
        durationMs: Date.now() - start,
      };
      fiscalYear = allabolagResult.fiscalYear;
      dataSource = 'allabolag';
      notes.push(`Data sourced from allabolag.se (${allabolagResult.sourceUrl})`);
      log.info(`${company.name}: allabolag provided partial data`);
    }
  }

  // Cross-validate fiscal year: PDF text vs discovery URL
  const fyCheck = crossValidateFiscalYear(fiscalYear, discoveryFiscalYear);
  if (fyCheck.warning) {
    notes.push(fyCheck.warning);
  }

  // Validate fiscal year range
  fiscalYear = validateFiscalYear(fiscalYear, notes);

  // Stage 5: Validation + confidence scoring
  let validationResult: StageResult<ExtractedData>;
  let confidence: number | null = null;

  const hasExtractedData =
    (extractionResult.status === 'success' || extractionResult.status === 'partial') &&
    extractionResult.value;

  if (hasExtractedData) {
    const start = Date.now();
    const validation = validateExtractedData(
      extractionResult.value!,
      company.companyType,
      notes,
    );
    validationResult = {
      status: dataSource === 'allabolag' ? 'partial' : 'success',
      value: validation.data,
      durationMs: Date.now() - start,
    };
    confidence = validation.confidence;

    // Cap allabolag-sourced confidence at 30
    if (dataSource === 'allabolag') {
      confidence = Math.min(confidence, 30);
    }

    for (const w of validation.warnings) {
      notes.push(w);
    }
  } else {
    validationResult = skipped;
  }

  // Sustainability extraction (BONUS — never blocks core pipeline)
  let sustainability: SustainabilityData;
  try {
    sustainability = await handleSustainability(
      company,
      annualReportText,
      reportUrl,
      downloadResult.value,
      sustainReportUrl,
      fiscalYear,
      force,
      notes,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    notes.push(`Sustainability extraction failed: ${message}`);
    sustainability = nullSustainability(`Extraction failed: ${message}`);
  }

  const status = determineStatus(validationResult.value);

  return {
    company: company.name,
    ticker: company.ticker,
    website: company.website,
    irPage: irResult.value,
    annualReportUrl: reportUrl,
    annualReportDownloaded: downloadResult.value,
    fiscalYear,
    extractedData: validationResult.value,
    sustainability,
    dataSource,
    confidence,
    status,
    extractionNotes: notes,
    stages: {
      irDiscovery: irResult,
      reportDiscovery: reportResult,
      download: downloadResult,
      extraction: extractionResult,
      validation: validationResult,
    },
  };
}

// ---------------------------------------------------------------------------
// Sustainability helper — downloads separate report if needed, extracts CO2
// ---------------------------------------------------------------------------

async function handleSustainability(
  company: CompanyProfile,
  annualReportText: string | null,
  annualReportUrl: string | null,
  annualReportDownloaded: string | null,
  sustainReportUrl: string | null,
  fiscalYear: number | null,
  force: boolean,
  notes: string[],
): Promise<SustainabilityData> {
  let sustainText: string | null = null;
  let sustainDownloaded: string | null = null;

  // If a standalone sustainability report was discovered, download it
  if (sustainReportUrl) {
    log.info(`[${company.name}] Downloading sustainability report: ${sustainReportUrl}`);
    const dlResult = await downloadPdf(
      sustainReportUrl,
      company.ticker,
      fiscalYear,
      force,
      'sustainability',
    );

    if (dlResult.status === 'success' && dlResult.value) {
      sustainDownloaded = dlResult.value;
      const pdfText = await extractTextFromPdf(dlResult.value, {
        ticker: company.ticker,
        fiscalYear,
        skipCache: false,
      });
      if (pdfText.text) {
        sustainText = pdfText.text;
      } else {
        notes.push(`Sustainability PDF text extraction failed: ${pdfText.extractionError ?? 'unknown'}`);
      }
    } else {
      notes.push(`Sustainability report download failed: ${dlResult.error ?? 'unknown'}`);
    }
  }

  // Extract CO2 data from available texts
  const extraction = extractSustainabilityData(annualReportText, sustainText);
  for (const n of extraction.notes) {
    notes.push(n);
  }

  // Build the final SustainabilityData object
  const reportUrl = sustainReportUrl ?? (
    extraction.scope1_co2_tonnes !== null || extraction.scope2_co2_tonnes !== null
      ? annualReportUrl
      : null
  );
  const reportDownloaded = sustainDownloaded ?? (
    extraction.scope1_co2_tonnes !== null || extraction.scope2_co2_tonnes !== null
      ? annualReportDownloaded
      : null
  );

  // Sustainability confidence: inherently lower than financials.
  // Both scopes found from a dedicated report = medium; from combined = low-medium;
  // only one scope = low; neither = null.
  const hasS1 = extraction.scope1_co2_tonnes !== null;
  const hasS2 = extraction.scope2_co2_tonnes !== null;
  type SConf = SustainabilityData['confidence'];
  let sustainConfidence: SConf = null;
  if (hasS1 && hasS2) {
    sustainConfidence = sustainDownloaded ? 'medium' : 'low';
  } else if (hasS1 || hasS2) {
    sustainConfidence = 'low';
  }

  return {
    reportUrl,
    reportDownloaded,
    scope1_co2_tonnes: extraction.scope1_co2_tonnes,
    scope2_co2_tonnes: extraction.scope2_co2_tonnes,
    methodology: extraction.methodology,
    confidence: sustainConfidence,
    note: extraction.notes.join('; '),
  };
}
