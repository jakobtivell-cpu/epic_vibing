// ---------------------------------------------------------------------------
// Pipeline orchestrator — bulletproof 7-step fallback chain per company.
//
// Steps (applied identically to every company):
//   1. Search engine discovery (Bing/DDG with filetype:pdf, multi-query)
//   2. Multi-domain Cheerio crawl (for each candidate domain)
//   3. Multi-domain Playwright crawl (for each domain with IR page)
//   4. Direct PDF search (reverse discovery — Bing filetype:pdf + URL patterns)
//   5. IR page HTML key figures extraction (medium confidence)
//   6. Allabolag.se fallback (org number + multi-variant name search)
//   7. Cached result preservation
//
// Each step tries up to MAX_CANDIDATES_PER_STEP PDF candidates through
// quality gates before advancing. A failed company never affects another.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import {
  CompanyProfile,
  CompanyType,
  PipelineResult,
  StageResult,
  ExtractedData,
  ReportDiscoveryResult,
  SustainabilityData,
  DataSource,
  ResultStatus,
  FallbackStep,
  ReportCandidate,
  SOURCE_PLAYWRIGHT_FALLBACK,
  SOURCE_SEARCH_DISCOVERY,
} from './types';
import { MAX_CANDIDATES_PER_STEP, RESULTS_PATH } from './config/settings';
import { searchDiscovery, directPdfSearch, deriveShortNames } from './discovery/search-discovery';
import { discoverIrPage } from './discovery/ir-finder';
import { discoverAnnualReport } from './discovery/report-ranker';
import { collectPublicationHubUrls } from './discovery/report-corpus';
import { filterAndRankReportCandidatesForEntity } from './discovery/candidate-ranking';
import { tryPlaywrightFallback } from './discovery/playwright-fallback';
import { buildEntityProfile, type EntityProfile } from './entity';
import { downloadPdf } from './download';
import { extractTextFromPdf, extractFields, extractFromAllabolag } from './extraction';
import { extractFromIrHtml } from './extraction/ir-html-extractor';
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

// ---------------------------------------------------------------------------
// Concurrency limiter
// ---------------------------------------------------------------------------

function createPool(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  function release() {
    active--;
    if (queue.length > 0) {
      const next = queue.shift()!;
      active++;
      next();
    }
  }

  async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active < concurrency) {
      active++;
    } else {
      await new Promise<void>((resolve) => queue.push(resolve));
      active++;
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return { run };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runPipeline(
  companies: CompanyProfile[],
  force: boolean,
): Promise<PipelineResult[]> {
  if (companies.length === 1) {
    const result = await processCompany(companies[0], force);
    return [result];
  }

  const pool = createPool(Math.min(companies.length, 10));
  const promises = companies.map((company, i) =>
    pool.run(async () => {
      log.info(`Processing ${company.name} [${i + 1}/${companies.length}]`);
      try {
        return await processCompany(company, force);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`[${company.name}] Fatal error: ${message}`);
        return buildFailedResult(company, message);
      }
    }),
  );

  return Promise.all(promises);
}

// ---------------------------------------------------------------------------
// Quality gates — applied identically to every PDF candidate
// ---------------------------------------------------------------------------

interface QualityGateResult {
  passed: boolean;
  reason: string | null;
  text: string | null;
  contentCheck: ReturnType<typeof verifyAnnualReportContent> | null;
}

function applyQualityGates(
  text: string,
  companyName: string,
): QualityGateResult {
  const textLength = text.length;

  if (textLength < 5_000) {
    return { passed: false, reason: `text too short (${textLength} chars)`, text: null, contentCheck: null };
  }

  const contentCheck = verifyAnnualReportContent(text);
  if (!contentCheck.hasIncomeStatement) {
    const lower = text.toLowerCase();
    const hasAnyFinancial = /intäkter|revenue|nettoomsättning|resultat/i.test(lower);
    if (!hasAnyFinancial) {
      return { passed: false, reason: 'no income statement signals', text: null, contentCheck };
    }
  }

  if (contentCheck.isGovernanceReport || contentCheck.isQuarterlyReport) {
    const reason = contentCheck.isGovernanceReport ? 'governance report' : 'quarterly report';
    return { passed: false, reason, text: null, contentCheck };
  }

  return { passed: true, reason: null, text, contentCheck };
}

// ---------------------------------------------------------------------------
// Try a list of PDF candidates through quality gates
// ---------------------------------------------------------------------------

interface PdfExtractionSuccess {
  success: true;
  reportUrl: string;
  downloadPath: string;
  annualReportText: string;
  extraction: ReturnType<typeof extractFields>;
  dataSource: DataSource;
  discoveryFiscalYear: number | null;
  notes: string[];
  contentCheck: ReturnType<typeof verifyAnnualReportContent>;
}

interface PdfExtractionFailure {
  success: false;
  notes: string[];
}

async function tryPdfCandidates(
  candidates: ReportCandidate[],
  entity: EntityProfile,
  force: boolean,
  stepName: FallbackStep,
  maxAttempts: number = MAX_CANDIDATES_PER_STEP,
  shortNames: string[],
): Promise<PdfExtractionSuccess | PdfExtractionFailure> {
  const notes: string[] = [];
  const triedUrls = new Set<string>();
  const slug = entity.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '');
  const verifyName = entity.searchAnchor;
  const ranked = filterAndRankReportCandidatesForEntity(candidates, entity);
  const entityOpts = {
    orgNumber: entity.orgNumber,
    ambiguityHigh: entity.ambiguityLevel === 'high',
    distinctiveTokens: entity.distinctiveTokens,
  };

  for (let i = 0; i < Math.min(ranked.length, maxAttempts); i++) {
    const candidate = ranked[i];
    if (triedUrls.has(candidate.url)) continue;
    triedUrls.add(candidate.url);

    const discoveryFiscalYear = extractYearFromCandidate(candidate);

    log.info(`[${entity.displayName}] Trying candidate #${i + 1} (${stepName}): ${candidate.url}`);

    const downloadResult = await downloadPdf(candidate.url, slug, discoveryFiscalYear, force);
    if (downloadResult.status !== 'success' || !downloadResult.value) {
      log.warn(`[${entity.displayName}] Download failed for candidate #${i + 1}`);
      notes.push(`Download failed for ${stepName} candidate #${i + 1}: ${candidate.url}`);
      continue;
    }

    const pdfText = await extractTextFromPdf(downloadResult.value, {
      ticker: slug,
      fiscalYear: discoveryFiscalYear,
    });

    if (!pdfText.text) {
      log.warn(`[${entity.displayName}] Text extraction failed for candidate #${i + 1}`);
      notes.push(`Text extraction failed for ${stepName} candidate #${i + 1}`);
      continue;
    }

    const gateResult = applyQualityGates(pdfText.text, verifyName);
    if (!gateResult.passed) {
      log.warn(`[${entity.displayName}] Quality gate rejected candidate #${i + 1}: ${gateResult.reason}`);
      notes.push(`Rejected ${stepName} candidate #${i + 1} "${candidate.url}" — ${gateResult.reason}`);
      continue;
    }

    const entityCheck = verifyEntityInPdf(pdfText.text, verifyName, shortNames, entityOpts);
    if (!entityCheck.passed) {
      log.warn(`[${entity.displayName}] Entity check FAILED for candidate #${i + 1} — likely wrong company's report`);
      notes.push(`Rejected ${stepName} candidate #${i + 1} "${candidate.url}" — entity check failed (wrong company)`);
      continue;
    }

    for (const w of gateResult.contentCheck!.warnings) {
      notes.push(w);
    }

    if (pdfText.suspiciouslyShort) {
      notes.push(`PDF text suspiciously short (${pdfText.textLength} chars / ${pdfText.pageCount} pages)`);
    }

    const extraction = extractFields(
      pdfText.text,
      verifyName,
      discoveryFiscalYear,
      entity.reportingModelHint !== 'unspecified' ? entity.reportingModelHint : null,
    );
    for (const n of extraction.notes) notes.push(n);

    const rev = extraction.data.revenue_msek;
    if (rev !== null && rev > 5_000_000) {
      log.warn(`[${entity.displayName}] Revenue ${rev} MSEK implausible — rejecting candidate #${i + 1}`);
      notes.push(`Rejected ${stepName} candidate #${i + 1} — revenue ${rev} MSEK implausible`);
      continue;
    }
    if (
      rev !== null &&
      rev < 1_000 &&
      entity.reportingModelHint !== 'bank' &&
      extraction.detectedCompanyType !== 'bank'
    ) {
      log.warn(`[${entity.displayName}] Revenue ${rev} MSEK implausible — rejecting candidate #${i + 1}`);
      notes.push(`Rejected ${stepName} candidate #${i + 1} — revenue ${rev} MSEK implausible`);
      continue;
    }

    let dataSource: DataSource;
    if (candidate.source === SOURCE_PLAYWRIGHT_FALLBACK) {
      dataSource = 'playwright+pdf';
    } else if (candidate.source === SOURCE_SEARCH_DISCOVERY) {
      dataSource = 'search+pdf';
    } else {
      dataSource = 'pdf';
    }

    return {
      success: true,
      reportUrl: candidate.url,
      downloadPath: downloadResult.value,
      annualReportText: pdfText.text,
      extraction,
      dataSource,
      discoveryFiscalYear,
      notes,
      contentCheck: gateResult.contentCheck!,
    };
  }

  return { success: false, notes };
}

function extractYearFromCandidate(candidate: ReportCandidate): number | null {
  const matches = (candidate.text + ' ' + candidate.url).match(/\b(20[12]\d)\b/g);
  if (!matches) return null;
  return Math.max(...matches.map(Number));
}

// ---------------------------------------------------------------------------
// Helper: apply a successful PDF extraction to pipeline state
// ---------------------------------------------------------------------------

interface PipelineState {
  fallbackStep: FallbackStep;
  reportUrl: string | null;
  downloadResult: StageResult<string>;
  annualReportText: string | null;
  dataSource: DataSource | null;
  discoveryFiscalYear: number | null;
  detectedCompanyType: CompanyType | null;
  fiscalYear: number | null;
  extractionResult: StageResult<ExtractedData>;
  notes: string[];
}

function applyPdfSuccess(state: PipelineState, attempt: PdfExtractionSuccess, step: FallbackStep): void {
  state.fallbackStep = step;
  state.reportUrl = attempt.reportUrl;
  state.downloadResult = { status: 'success', value: attempt.downloadPath };
  state.annualReportText = attempt.annualReportText;
  state.dataSource = attempt.dataSource;
  state.discoveryFiscalYear = attempt.discoveryFiscalYear;
  state.detectedCompanyType = attempt.extraction.detectedCompanyType;
  state.fiscalYear = attempt.extraction.fiscalYear;
  state.extractionResult = { status: 'success', value: attempt.extraction.data };
  state.notes.push(...attempt.notes);
}

/**
 * Sort candidate domains in-place so the most relevant ones come first.
 * Prioritises: .se TLDs, hostname matching a short name, and penalises
 * domains that redirected to a foreign TLD (e.g. seb.com → groupeseb.com/fr).
 */
function sortDomainsByRelevance(domains: string[], shortNames: string[]): void {
  const snLower = shortNames.map((s) => s.toLowerCase());

  domains.sort((a, b) => {
    const scoreA = domainRelevanceScore(a, snLower);
    const scoreB = domainRelevanceScore(b, snLower);
    return scoreB - scoreA;
  });
}

function domainRelevanceScore(url: string, shortNamesLower: string[]): number {
  let score = 0;
  try {
    const u = new URL(url);
    const hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    const tld = hostname.split('.').pop() ?? '';

    // Swedish TLD bonus
    if (tld === 'se') score += 10;
    // Swedish-adjacent TLDs
    if (tld === 'com') score += 2;
    // Penalise non-English/Swedish paths (e.g. /fr, /de)
    if (/^\/(fr|de|es|it|pt|ja|zh|ko)\b/i.test(u.pathname)) score -= 15;

    // Hostname matches a short name exactly or as prefix
    for (const sn of shortNamesLower) {
      const snSlug = sn.replace(/[^a-z0-9]/g, '');
      if (hostname.startsWith(snSlug + '.') || hostname.startsWith(snSlug + 'group.')) {
        score += 8;
        break;
      }
      if (hostname.includes(snSlug)) {
        score += 3;
      }
    }
  } catch { /* skip */ }
  return score;
}

// ---------------------------------------------------------------------------
// Main company processing — 7-step bulletproof fallback chain
// ---------------------------------------------------------------------------

async function processCompany(
  company: CompanyProfile,
  force: boolean,
): Promise<PipelineResult> {
  const entity = buildEntityProfile(company);
  const name = company.name;
  const shortNames = deriveShortNames(entity.searchAnchor, company.ticker);

  const skipped: StageResult<never> = {
    status: 'skipped',
    value: null,
    error: 'Skipped because a prior stage did not succeed',
  };

  let irResult: StageResult<string> = skipped;
  let reportResult: StageResult<ReportDiscoveryResult> = skipped;

  const state: PipelineState = {
    fallbackStep: 'none',
    reportUrl: null,
    downloadResult: skipped,
    annualReportText: null,
    dataSource: null,
    discoveryFiscalYear: null,
    detectedCompanyType: null,
    fiscalYear: null,
    extractionResult: skipped,
    notes: [
      `ENTITY_PROFILE: searchAnchor="${entity.searchAnchor}" ambiguity=${entity.ambiguityLevel} reportingHint=${entity.reportingModelHint} org=${entity.orgNumber ?? 'none'}`,
    ],
  };

  let validationResult: StageResult<ExtractedData> = skipped;
  let confidence: number | null = null;
  let website = company.website ?? null;
  let irPageUrl: string | null = null;
  const candidateDomains: string[] = [...entity.seedCandidateDomains];

  // =========================================================================
  // Step 1: Search engine discovery (filetype:pdf, multi-query, short names)
  // =========================================================================
  log.info(`[${name}] === Step 1: Search engine discovery ===`);
  const searchResult = await searchDiscovery(entity.searchAnchor, company.ticker);

  if (!website && searchResult.discoveredWebsite) {
    website = searchResult.discoveredWebsite;
    log.info(`[${name}] Discovered website: ${website}`);
  }

  // Collect all discovered domains for multi-domain cycling
  for (const domain of searchResult.allDiscoveredDomains) {
    if (!candidateDomains.includes(domain)) {
      candidateDomains.push(domain);
    }
  }
  if (website && !candidateDomains.includes(website)) {
    candidateDomains.unshift(website);
  }

  // Sort domains: prefer .se TLDs and domains matching company short names
  sortDomainsByRelevance(candidateDomains, shortNames);

  if (searchResult.pdfCandidates.length > 0) {
    const searchAttempt = await tryPdfCandidates(
      searchResult.pdfCandidates, entity, force, 'search',
      MAX_CANDIDATES_PER_STEP, shortNames,
    );
    if (searchAttempt.success) {
      applyPdfSuccess(state, searchAttempt, 'search');
    } else {
      state.notes.push(...searchAttempt.notes);
    }
  }

  // =========================================================================
  // Step 2+3: Multi-domain Cheerio + Playwright cycling
  // =========================================================================
  if (!state.extractionResult.value && candidateDomains.length > 0) {
    log.info(`[${name}] === Step 2+3: Multi-domain cycling (${candidateDomains.length} domains) ===`);

    for (const domain of candidateDomains) {
      if (state.extractionResult.value) break;

      log.info(`[${name}] --- Trying domain: ${domain} ---`);

      // Step 2: Cheerio IR discovery + report scan
      const domainIrResult = await discoverIrPage(entity.searchAnchor, domain);

      if (domainIrResult.status === 'success' && domainIrResult.value) {
        const domainIrUrl = domainIrResult.value;
        if (!irPageUrl) irPageUrl = domainIrUrl;
        irResult = domainIrResult;

        const domainReportResult = await discoverAnnualReport(entity.searchAnchor, domain, domainIrUrl);

        let mergedCandidates = [...(domainReportResult.value?.allCandidates ?? [])];
        const hubUrls = await collectPublicationHubUrls(domain);
        state.notes.push(`REPORT_CORPUS: ${hubUrls.length} publication hub(s) probed on ${domain}`);
        const seenCand = new Set(mergedCandidates.map((c) => c.url));
        for (const hub of hubUrls) {
          if (hub.replace(/\/$/, '') === domainIrUrl.replace(/\/$/, '')) continue;
          const extra = await discoverAnnualReport(entity.searchAnchor, domain, hub);
          if (extra.value?.allCandidates?.length) {
            for (const c of extra.value.allCandidates) {
              if (!seenCand.has(c.url)) {
                mergedCandidates.push(c);
                seenCand.add(c.url);
              }
            }
          }
        }
        mergedCandidates = filterAndRankReportCandidatesForEntity(mergedCandidates, entity);

        if (mergedCandidates.length > 0) {
          reportResult = domainReportResult;

          const cheerioAttempt = await tryPdfCandidates(
            mergedCandidates, entity, force, 'cheerio',
            MAX_CANDIDATES_PER_STEP, shortNames,
          );

          if (cheerioAttempt.success) {
            applyPdfSuccess(state, cheerioAttempt, 'cheerio');
            break;
          }
          state.notes.push(...cheerioAttempt.notes);
        }

        // Step 3: Playwright on this domain's IR page
        if (!state.extractionResult.value) {
          log.info(`[${name}] Playwright crawl on: ${domainIrUrl}`);
          const playwrightCandidates = await tryPlaywrightFallback(entity.searchAnchor, domainIrUrl);

          if (playwrightCandidates.length > 0) {
            const rankedPw = filterAndRankReportCandidatesForEntity(playwrightCandidates, entity);
            const pwAttempt = await tryPdfCandidates(
              rankedPw, entity, force, 'playwright',
              MAX_CANDIDATES_PER_STEP, shortNames,
            );

            if (pwAttempt.success) {
              applyPdfSuccess(state, pwAttempt, 'playwright');
              break;
            }
            state.notes.push(...pwAttempt.notes);
          }
        }
      }
    }

    // Also try IR pages discovered by search if no IR was found on any domain
    if (!state.extractionResult.value && searchResult.irPageCandidates.length > 0 && !irPageUrl) {
      for (const candidateIr of searchResult.irPageCandidates.slice(0, 3)) {
        if (state.extractionResult.value) break;
        log.info(`[${name}] Trying search-discovered IR page: ${candidateIr}`);

        const w = website ?? candidateDomains[0];
        if (!w) continue;

        const searchIrReport = await discoverAnnualReport(entity.searchAnchor, w, candidateIr);
        if (searchIrReport.value?.allCandidates && searchIrReport.value.allCandidates.length > 0) {
          irPageUrl = candidateIr;
          reportResult = searchIrReport;

          const rankedSearch = filterAndRankReportCandidatesForEntity(
            searchIrReport.value.allCandidates,
            entity,
          );
          const attempt = await tryPdfCandidates(
            rankedSearch, entity, force, 'cheerio',
            MAX_CANDIDATES_PER_STEP, shortNames,
          );

          if (attempt.success) {
            applyPdfSuccess(state, attempt, 'cheerio');
          } else {
            state.notes.push(...attempt.notes);
          }
        }
      }
    }
  }

  // =========================================================================
  // Step 4: Direct PDF search (reverse discovery — no website required)
  // =========================================================================
  if (!state.extractionResult.value) {
    log.info(`[${name}] === Step 4: Direct PDF search (reverse discovery) ===`);
    const directCandidates = await directPdfSearch(
      entity.searchAnchor, company.ticker, candidateDomains,
    );

    if (directCandidates.length > 0) {
      const rankedDirect = filterAndRankReportCandidatesForEntity(directCandidates, entity);
      const directAttempt = await tryPdfCandidates(
        rankedDirect, entity, force, 'direct-pdf-search',
        MAX_CANDIDATES_PER_STEP, shortNames,
      );

      if (directAttempt.success) {
        applyPdfSuccess(state, directAttempt, 'direct-pdf-search');
      } else {
        state.notes.push(...directAttempt.notes);
      }
    }
  }

  // =========================================================================
  // Step 5: IR page HTML key figures extraction (medium confidence)
  // =========================================================================
  if (!state.extractionResult.value && irPageUrl) {
    log.info(`[${name}] === Step 5: IR page HTML key figures ===`);
    const irHtmlResult = await extractFromIrHtml(irPageUrl, entity.searchAnchor);

    if (irHtmlResult) {
      state.fallbackStep = 'ir-html';
      state.extractionResult = {
        status: 'partial',
        value: irHtmlResult.data,
      };
      state.fiscalYear = irHtmlResult.fiscalYear;
      state.dataSource = 'ir-html';
      confidence = irHtmlResult.confidence;
      state.notes.push(`Data sourced from IR page HTML (${irHtmlResult.sourceUrl})`);
      log.info(`[${name}] IR HTML provided data (confidence: ${irHtmlResult.confidence}%)`);
    }
  }

  // =========================================================================
  // Step 6: Allabolag.se fallback (org number + multi-variant name search)
  // =========================================================================
  if (!state.extractionResult.value) {
    log.info(`[${name}] === Step 6: Allabolag.se fallback ===`);
    const start = Date.now();
    const allabolagResult = await extractFromAllabolag(
      name, company.legalName, company.orgNumber, shortNames,
    );

    if (allabolagResult) {
      state.fallbackStep = 'allabolag';
      state.extractionResult = {
        status: 'partial',
        value: allabolagResult.data,
        error: allabolagResult.explanation,
        durationMs: Date.now() - start,
      };
      state.fiscalYear = allabolagResult.fiscalYear;
      state.dataSource = 'allabolag';
      state.notes.push(`Data sourced from allabolag.se (${allabolagResult.sourceUrl})`);
      log.info(`[${name}] Allabolag provided partial data`);
    }
  }

  // =========================================================================
  // Cross-validate and finalize
  // =========================================================================

  const fyCheck = crossValidateFiscalYear(state.fiscalYear, state.discoveryFiscalYear);
  if (fyCheck.warning) state.notes.push(fyCheck.warning);

  state.fiscalYear = validateFiscalYear(state.fiscalYear, state.notes);

  const hasExtractedData =
    (state.extractionResult.status === 'success' || state.extractionResult.status === 'partial') &&
    state.extractionResult.value;

  if (hasExtractedData) {
    const start = Date.now();
    const validation = validateExtractedData(
      state.extractionResult.value!,
      state.detectedCompanyType ?? undefined,
      state.notes,
    );
    validationResult = {
      status: state.dataSource === 'allabolag' || state.dataSource === 'ir-html' ? 'partial' : 'success',
      value: validation.data,
      durationMs: Date.now() - start,
    };

    if (confidence === null) {
      confidence = validation.confidence;
    }

    if (state.dataSource === 'allabolag') {
      confidence = Math.min(confidence, 30);
    }

    for (const w of validation.warnings) state.notes.push(w);
  }

  // Sustainability
  let sustainability: SustainabilityData;
  try {
    sustainability = await handleSustainability(
      name, state.annualReportText, state.reportUrl, state.downloadResult.value,
      reportResult.value?.sustainabilityReportUrl ?? null,
      state.fiscalYear, force, state.notes,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    state.notes.push(`Sustainability extraction failed: ${message}`);
    sustainability = nullSustainability(`Extraction failed: ${message}`);
  }

  // Step 7: Preserve last known good result if this run failed completely
  let cached = false;
  let cachedAt: string | undefined;
  if (state.fallbackStep === 'none') {
    const previous = loadPreviousResult(name);
    if (previous && previous.status !== 'failed') {
      log.info(`[${name}] All steps exhausted — preserving last known good result`);
      cached = true;
      cachedAt = new Date().toISOString();
      return {
        ...previous,
        cached,
        cachedAt,
        fallbackStepReached: 'cached' as FallbackStep,
        extractionNotes: [...(previous.extractionNotes ?? []), 'CACHED: all discovery steps failed, using previous result'],
      };
    }
  }

  const status = determineStatus(validationResult.value);

  return {
    company: name,
    ticker: company.ticker ?? null,
    website,
    irPage: irPageUrl,
    annualReportUrl: state.reportUrl,
    annualReportDownloaded: state.downloadResult.value,
    fiscalYear: state.fiscalYear,
    extractedData: validationResult.value,
    sustainability,
    dataSource: state.dataSource,
    confidence,
    status,
    fallbackStepReached: state.fallbackStep,
    detectedCompanyType: state.detectedCompanyType,
    cached,
    cachedAt,
    extractionNotes: state.notes,
    stages: {
      irDiscovery: irResult,
      reportDiscovery: reportResult,
      download: state.downloadResult,
      extraction: state.extractionResult,
      validation: validationResult,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function validateFiscalYear(year: number | null, notes: string[]): number | null {
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

function loadPreviousResult(companyName: string): PipelineResult | null {
  try {
    if (!fs.existsSync(RESULTS_PATH)) return null;
    const raw = fs.readFileSync(RESULTS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    const results: PipelineResult[] = Array.isArray(parsed) ? parsed : parsed.results ?? [];
    return results.find((r) => r.company.toLowerCase() === companyName.toLowerCase()) ?? null;
  } catch {
    return null;
  }
}

function buildFailedResult(company: CompanyProfile, error: string): PipelineResult {
  const skipped: StageResult<never> = { status: 'failed', value: null, error };
  return {
    company: company.name,
    ticker: company.ticker ?? null,
    website: company.website ?? null,
    irPage: null,
    annualReportUrl: null,
    annualReportDownloaded: null,
    fiscalYear: null,
    extractedData: null,
    sustainability: nullSustainability('Pipeline failed'),
    dataSource: null,
    confidence: null,
    status: 'failed',
    fallbackStepReached: 'none',
    detectedCompanyType: null,
    cached: false,
    extractionNotes: [error],
    stages: {
      irDiscovery: skipped,
      reportDiscovery: skipped,
      download: skipped,
      extraction: skipped,
      validation: skipped,
    },
  };
}

// ---------------------------------------------------------------------------
// Sustainability helper
// ---------------------------------------------------------------------------

async function handleSustainability(
  companyName: string,
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
  const slug = companyName.toLowerCase().replace(/[^a-z0-9]+/g, '_');

  if (sustainReportUrl) {
    log.info(`[${companyName}] Downloading sustainability report: ${sustainReportUrl}`);
    const dlResult = await downloadPdf(sustainReportUrl, slug, fiscalYear, force, 'sustainability');

    if (dlResult.status === 'success' && dlResult.value) {
      sustainDownloaded = dlResult.value;
      const pdfText = await extractTextFromPdf(dlResult.value, {
        ticker: slug,
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

  const extraction = extractSustainabilityData(annualReportText, sustainText);
  for (const n of extraction.notes) notes.push(n);

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
