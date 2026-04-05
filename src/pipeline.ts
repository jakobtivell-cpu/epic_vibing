// ---------------------------------------------------------------------------
// Pipeline orchestrator — bulletproof 7-step fallback chain per company.
//
// Steps (applied identically to every company):
//   1. Search engine discovery (domains + PDF URL list only — no download yet)
//   2. Multi-domain Cheerio crawl (IR page → report ranker → real PDFs first)
//   3. Multi-domain Playwright crawl (for each domain with IR page)
//   1b. Search-guessed PDF URLs (only after IR crawl fails — avoids rate limits)
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
import {
  searchDiscovery,
  directPdfSearch,
  deriveShortNames,
  type SearchDiscoveryResult,
} from './discovery/search-discovery';
import { discoverIrPage } from './discovery/ir-finder';
import { discoverAnnualReport, quickScanPdfCandidatesOnPage } from './discovery/report-ranker';
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
import { runChallengerTrack } from './challenger';

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

export interface RunPipelineOptions {
  /** When true and more than one company, run one at a time (rate-limit friendly). */
  sequential?: boolean;
  /**
   * When true and `OPENAI_API_KEY` is set, run the LLM challenger even if the gate would skip
   * (still requires PDF text on the primary path).
   */
  llmChallengerForce?: boolean;
}

export async function runPipeline(
  companies: CompanyProfile[],
  force: boolean,
  options?: RunPipelineOptions,
): Promise<PipelineResult[]> {
  if (companies.length === 0) {
    return [];
  }

  if (companies.length === 1) {
    const result = await processCompany(companies[0], force, options);
    return [result];
  }

  if (options?.sequential) {
    const results: PipelineResult[] = [];
    for (let i = 0; i < companies.length; i++) {
      const company = companies[i];
      log.info(`Processing ${company.name} [${i + 1}/${companies.length}]`);
      try {
        results.push(await processCompany(company, force, options));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`[${company.name}] Fatal error: ${message}`);
        results.push(buildFailedResult(company, message));
      }
    }
    return results;
  }

  const pool = createPool(Math.min(companies.length, 10));
  const promises = companies.map((company, i) =>
    pool.run(async () => {
      log.info(`Processing ${company.name} [${i + 1}/${companies.length}]`);
      try {
        return await processCompany(company, force, options);
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
  pdfPageCount: number;
  suspiciouslyShortPdf: boolean;
}

interface PdfExtractionFailure {
  success: false;
  notes: string[];
}

/** Optional circuit breaking for PDF download storms (search-guessed URLs, rate limits). */
interface TryPdfCircuitOptions {
  /** After this many download failures on a host, skip remaining candidates on that host. */
  maxFailuresPerHost?: number;
  /** After this many consecutive 403/404-class failures on a host, skip that host. */
  consecutiveForbiddenAbortPerHost?: number;
}

function pdfUrlHostKey(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '_invalid_';
  }
}

function isForbiddenOrNotFoundError(message: string | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    /\b403\b/.test(m) ||
    /\b404\b/.test(m) ||
    /status code 403/.test(m) ||
    /status code 404/.test(m)
  );
}

async function tryPdfCandidates(
  candidates: ReportCandidate[],
  entity: EntityProfile,
  force: boolean,
  stepName: FallbackStep,
  maxAttempts: number = MAX_CANDIDATES_PER_STEP,
  shortNames: string[],
  circuit?: TryPdfCircuitOptions,
): Promise<PdfExtractionSuccess | PdfExtractionFailure> {
  const notes: string[] = [];
  const triedUrls = new Set<string>();
  const slug = entity.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '');
  const verifyName = entity.searchAnchor;
  const ranked = filterAndRankReportCandidatesForEntity(candidates, entity);

  const hostFailureCount = new Map<string, number>();
  const hostConsecutiveForbidden = new Map<string, number>();
  const hostFullySkipped = new Set<string>();

  let downloadAttempts = 0;
  let displayIndex = 0;

  for (const candidate of ranked) {
    if (downloadAttempts >= maxAttempts) break;

    if (triedUrls.has(candidate.url)) continue;
    triedUrls.add(candidate.url);

    const host = pdfUrlHostKey(candidate.url);
    if (hostFullySkipped.has(host)) continue;

    const fails = hostFailureCount.get(host) ?? 0;
    if (circuit?.maxFailuresPerHost != null && fails >= circuit.maxFailuresPerHost) {
      if (!hostFullySkipped.has(host)) {
        hostFullySkipped.add(host);
        notes.push(
          `${stepName}: skipping remaining URLs on ${host} (${fails} failures ≥ ${circuit.maxFailuresPerHost})`,
        );
      }
      continue;
    }

    downloadAttempts++;
    displayIndex++;
    const discoveryFiscalYear = extractYearFromCandidate(candidate);

    log.info(`[${entity.displayName}] Trying candidate #${displayIndex} (${stepName}): ${candidate.url}`);

    const downloadResult = await downloadPdf(candidate.url, slug, discoveryFiscalYear, force);
    if (downloadResult.status !== 'success' || !downloadResult.value) {
      log.warn(`[${entity.displayName}] Download failed for candidate #${displayIndex}`);
      notes.push(`Download failed for ${stepName} candidate #${displayIndex}: ${candidate.url}`);

      const errMsg = downloadResult.error;
      const nextFails = fails + 1;
      hostFailureCount.set(host, nextFails);

      if (isForbiddenOrNotFoundError(errMsg)) {
        const streak = (hostConsecutiveForbidden.get(host) ?? 0) + 1;
        hostConsecutiveForbidden.set(host, streak);
        const abortAt = circuit?.consecutiveForbiddenAbortPerHost;
        if (abortAt != null && streak >= abortAt) {
          hostFullySkipped.add(host);
          notes.push(
            `${stepName}: ${streak} consecutive 403/404 on ${host} — skipping further guesses on this host`,
          );
        }
      } else {
        hostConsecutiveForbidden.set(host, 0);
      }

      if (circuit?.maxFailuresPerHost != null && nextFails >= circuit.maxFailuresPerHost) {
        hostFullySkipped.add(host);
        notes.push(
          `${stepName}: ${nextFails} failures on ${host} — skipping remaining candidates on this host`,
        );
      }

      continue;
    }

    hostConsecutiveForbidden.set(host, 0);

    const pdfText = await extractTextFromPdf(downloadResult.value, {
      ticker: slug,
      fiscalYear: discoveryFiscalYear,
    });

    if (!pdfText.text) {
      log.warn(`[${entity.displayName}] Text extraction failed for candidate #${displayIndex}`);
      notes.push(`Text extraction failed for ${stepName} candidate #${displayIndex}`);
      continue;
    }

    const gateResult = applyQualityGates(pdfText.text, verifyName);
    if (!gateResult.passed) {
      log.warn(`[${entity.displayName}] Quality gate rejected candidate #${displayIndex}: ${gateResult.reason}`);
      notes.push(`Rejected ${stepName} candidate #${displayIndex} "${candidate.url}" — ${gateResult.reason}`);
      continue;
    }

    const entityCheck = verifyEntityInPdf(pdfText.text, entity);
    if (!entityCheck.passed) {
      log.warn(`[${entity.displayName}] Entity check FAILED for candidate #${displayIndex} — likely wrong company's report`);
      notes.push(`Rejected ${stepName} candidate #${displayIndex} "${candidate.url}" — entity check failed (wrong company)`);
      continue;
    }
    notes.push(`Entity verified (${entityCheck.matchedTerm})`);

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
      log.warn(`[${entity.displayName}] Revenue ${rev} MSEK implausible — rejecting candidate #${displayIndex}`);
      notes.push(`Rejected ${stepName} candidate #${displayIndex} — revenue ${rev} MSEK implausible`);
      continue;
    }
    if (
      rev !== null &&
      rev < 1_000 &&
      entity.reportingModelHint !== 'bank' &&
      extraction.detectedCompanyType !== 'bank'
    ) {
      log.warn(`[${entity.displayName}] Revenue ${rev} MSEK implausible — rejecting candidate #${displayIndex}`);
      notes.push(`Rejected ${stepName} candidate #${displayIndex} — revenue ${rev} MSEK implausible`);
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
      pdfPageCount: pdfText.pageCount,
      suspiciouslyShortPdf: pdfText.suspiciouslyShort,
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
  /** Provenance from the last successful PDF `extractFields` (null for IR HTML / allabolag). */
  lastFieldExtraction: ReturnType<typeof extractFields> | null;
  pdfPageCount: number;
  suspiciouslyShortPdf: boolean;
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
  state.lastFieldExtraction = attempt.extraction;
  state.pdfPageCount = attempt.pdfPageCount;
  state.suspiciouslyShortPdf = attempt.suspiciouslyShortPdf;
  state.notes.push(...attempt.notes);
}

function emptySearchDiscoveryResult(): SearchDiscoveryResult {
  return {
    pdfCandidates: [],
    discoveredWebsite: null,
    allDiscoveredDomains: [],
    searchEngineDomains: [],
    slugInferenceDomains: [],
    irPageCandidates: [],
  };
}

function originHostKey(origin: string): string {
  try {
    const u = new URL(origin.startsWith('http') ? origin : `https://${origin}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function mergeSearchDiscovery(target: SearchDiscoveryResult, incoming: SearchDiscoveryResult): void {
  const pdfSeen = new Set(target.pdfCandidates.map((c) => c.url));
  for (const c of incoming.pdfCandidates) {
    if (!pdfSeen.has(c.url)) {
      target.pdfCandidates.push(c);
      pdfSeen.add(c.url);
    }
  }
  const irSeen = new Set(target.irPageCandidates);
  for (const u of incoming.irPageCandidates) {
    if (!irSeen.has(u)) {
      target.irPageCandidates.push(u);
      irSeen.add(u);
    }
  }
}

// ---------------------------------------------------------------------------
// Main company processing — 7-step bulletproof fallback chain
// ---------------------------------------------------------------------------

async function processCompany(
  company: CompanyProfile,
  force: boolean,
  pipelineOpts?: RunPipelineOptions,
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
    lastFieldExtraction: null,
    pdfPageCount: 0,
    suspiciouslyShortPdf: false,
    notes: [
      `ENTITY_PROFILE: searchAnchor="${entity.searchAnchor}" ambiguity=${entity.ambiguityLevel} reportingHint=${entity.reportingModelHint} org=${entity.orgNumber ?? 'none'}`,
    ],
  };

  let validationResult: StageResult<ExtractedData> = skipped;
  let confidence: number | null = null;
  let website = company.website ?? null;
  let irPageUrl: string | null = null;

  const websiteTrimmed = company.website?.trim() ?? '';
  const hasTrustedOrigin =
    entity.seedCandidateDomains.length > 0 || Boolean(websiteTrimmed);

  // =========================================================================
  // Step 1: Search engine discovery (filetype:pdf, multi-query, short names)
  // Skipped when ticker.json seeds or a known website exist — IR runs first;
  // search runs later only if extraction still failed (deferred block below).
  // =========================================================================
  let searchResult: SearchDiscoveryResult;
  if (hasTrustedOrigin) {
    log.info(`[${name}] === Step 1: Search engine discovery (skipped — trusted domains/website) ===`);
    searchResult = emptySearchDiscoveryResult();
  } else {
    log.info(`[${name}] === Step 1: Search engine discovery ===`);
    searchResult = await searchDiscovery(
      entity.searchAnchor,
      company.ticker,
      entity.seedCandidateDomains,
    );
  }

  if (!website && searchResult.discoveredWebsite) {
    website = searchResult.discoveredWebsite;
    log.info(`[${name}] Discovered website: ${website}`);
  }

  // Domain order: ticker.json seeds → primary discovered website → search-tier → slug-tier → other discovery (deduped by host)
  const candidateDomains: string[] = [];
  const seenHosts = new Set<string>();
  const pushDomain = (url: string | null | undefined) => {
    if (!url || typeof url !== 'string') return;
    try {
      const u = new URL(url.startsWith('http') ? url : `https://${url}`);
      const h = u.hostname.replace(/^www\./, '').toLowerCase();
      if (seenHosts.has(h)) return;
      seenHosts.add(h);
      candidateDomains.push(url.replace(/\/$/, ''));
    } catch {
      /* skip */
    }
  };

  for (const d of entity.seedCandidateDomains) {
    pushDomain(d);
  }
  if (website) {
    pushDomain(website);
  }
  for (const d of searchResult.searchEngineDomains ?? []) {
    pushDomain(d);
  }
  for (const d of searchResult.slugInferenceDomains ?? []) {
    pushDomain(d);
  }
  for (const d of searchResult.allDiscoveredDomains) {
    pushDomain(d);
  }

  const CIRCUIT_PER_HOST = { maxFailuresPerHost: 3 as const };
  const CIRCUIT_SEARCH_GUESSES = {
    maxFailuresPerHost: 3 as const,
    consecutiveForbiddenAbortPerHost: 2 as const,
  };

  // =========================================================================
  // Step 2+3: Multi-domain Cheerio + Playwright cycling (before search-guessed PDFs)
  // =========================================================================
  const attemptedIrHosts = new Set<string>();

  const processDomain = async (domain: string): Promise<void> => {
    log.info(`[${name}] --- Trying domain: ${domain} ---`);

    const domainIrResult = await discoverIrPage(entity.searchAnchor, domain);

    if (domainIrResult.status === 'success' && domainIrResult.value) {
      const domainIrUrl = domainIrResult.value;
      if (!irPageUrl) irPageUrl = domainIrUrl;
      irResult = domainIrResult;

      const domainReportResult = await discoverAnnualReport(
        entity.searchAnchor,
        domain,
        domainIrUrl,
        { skipFallbackLadder: true },
      );

      let mergedCandidates = [...(domainReportResult.value?.allCandidates ?? [])];
      const hubUrls = await collectPublicationHubUrls(domain);
      state.notes.push(
        `REPORT_CORPUS: ${hubUrls.length} publication hub(s) quick-probed (single-page scan only) on ${domain}`,
      );
      const seenCand = new Set(mergedCandidates.map((c) => c.url));
      for (const hub of hubUrls) {
        if (hub.replace(/\/$/, '') === domainIrUrl.replace(/\/$/, '')) continue;
        const quick = await quickScanPdfCandidatesOnPage(entity.searchAnchor, hub);
        for (const c of quick) {
          if (!seenCand.has(c.url)) {
            mergedCandidates.push(c);
            seenCand.add(c.url);
          }
        }
      }
      mergedCandidates = filterAndRankReportCandidatesForEntity(mergedCandidates, entity);

      if (mergedCandidates.length > 0) {
        reportResult = domainReportResult;

        const irHigh = mergedCandidates.filter((c) => c.score >= 10);
        const irLow = mergedCandidates.filter((c) => c.score < 10);

        if (irHigh.length > 0) {
          const cheerioAttempt = await tryPdfCandidates(
            irHigh, entity, force, 'cheerio',
            MAX_CANDIDATES_PER_STEP, shortNames,
            CIRCUIT_PER_HOST,
          );

          if (cheerioAttempt.success) {
            applyPdfSuccess(state, cheerioAttempt, 'cheerio');
            return;
          }
          state.notes.push(...cheerioAttempt.notes);
        }

        if (!state.extractionResult.value && irLow.length > 0) {
          const cheerioLowAttempt = await tryPdfCandidates(
            irLow, entity, force, 'cheerio',
            MAX_CANDIDATES_PER_STEP, shortNames,
            CIRCUIT_PER_HOST,
          );

          if (cheerioLowAttempt.success) {
            applyPdfSuccess(state, cheerioLowAttempt, 'cheerio');
            return;
          }
          state.notes.push(...cheerioLowAttempt.notes);
        }
      }

      if (!state.extractionResult.value) {
        log.info(`[${name}] Playwright crawl on: ${domainIrUrl}`);
        const playwrightCandidates = await tryPlaywrightFallback(entity.searchAnchor, domainIrUrl);

        if (playwrightCandidates.length > 0) {
          const rankedPw = filterAndRankReportCandidatesForEntity(playwrightCandidates, entity);
          const pwAttempt = await tryPdfCandidates(
            rankedPw, entity, force, 'playwright',
            MAX_CANDIDATES_PER_STEP, shortNames,
            CIRCUIT_PER_HOST,
          );

          if (pwAttempt.success) {
            applyPdfSuccess(state, pwAttempt, 'playwright');
          } else {
            state.notes.push(...pwAttempt.notes);
          }
        }
      }

      if (!state.extractionResult.value) {
        log.info(`[${name}] Cheerio deep fallback (full ladder once) on primary IR: ${domainIrUrl}`);
        const deepReport = await discoverAnnualReport(entity.searchAnchor, domain, domainIrUrl);
        if (deepReport.value?.allCandidates?.length) {
          reportResult = deepReport.status === 'success' ? deepReport : reportResult;
          const rankedDeep = filterAndRankReportCandidatesForEntity(
            deepReport.value.allCandidates,
            entity,
          );
          const irHighDeep = rankedDeep.filter((c) => c.score >= 10);
          const irLowDeep = rankedDeep.filter((c) => c.score < 10);

          if (irHighDeep.length > 0) {
            const cheerioDeep = await tryPdfCandidates(
              irHighDeep, entity, force, 'cheerio',
              MAX_CANDIDATES_PER_STEP, shortNames,
              CIRCUIT_PER_HOST,
            );
            if (cheerioDeep.success) {
              applyPdfSuccess(state, cheerioDeep, 'cheerio');
              return;
            }
            state.notes.push(...cheerioDeep.notes);
          }

          if (!state.extractionResult.value && irLowDeep.length > 0) {
            const cheerioLowDeep = await tryPdfCandidates(
              irLowDeep, entity, force, 'cheerio',
              MAX_CANDIDATES_PER_STEP, shortNames,
              CIRCUIT_PER_HOST,
            );
            if (cheerioLowDeep.success) {
              applyPdfSuccess(state, cheerioLowDeep, 'cheerio');
              return;
            }
            state.notes.push(...cheerioLowDeep.notes);
          }
        }
      }
    }
  };

  const runSearchIrFallbackIfNeeded = async (): Promise<void> => {
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
            CIRCUIT_PER_HOST,
          );

          if (attempt.success) {
            applyPdfSuccess(state, attempt, 'cheerio');
          } else {
            state.notes.push(...attempt.notes);
          }
        }
      }
    }
  };

  const runMultiDomainIr = async (domains: string[], phaseSuffix: string): Promise<void> => {
    if (!state.extractionResult.value && domains.length > 0) {
      log.info(
        `[${name}] === Step 2+3: Multi-domain cycling (${domains.length} domains)${phaseSuffix} ===`,
      );
      for (const domain of domains) {
        if (state.extractionResult.value) break;
        const hk = originHostKey(domain);
        if (!hk) continue;
        if (attemptedIrHosts.has(hk)) continue;
        attemptedIrHosts.add(hk);
        await processDomain(domain);
      }
    }
  };

  await runMultiDomainIr(candidateDomains, '');
  if (candidateDomains.length > 0) {
    await runSearchIrFallbackIfNeeded();
  }

  if (!state.extractionResult.value && hasTrustedOrigin) {
    log.info(`[${name}] === Step 1: Search engine discovery (deferred) ===`);
    const deferred = await searchDiscovery(
      entity.searchAnchor,
      company.ticker,
      entity.seedCandidateDomains,
    );
    mergeSearchDiscovery(searchResult, deferred);

    if (!website && deferred.discoveredWebsite) {
      website = deferred.discoveredWebsite;
      log.info(`[${name}] Discovered website: ${website}`);
    }

    for (const d of deferred.searchEngineDomains ?? []) {
      pushDomain(d);
    }
    for (const d of deferred.slugInferenceDomains ?? []) {
      pushDomain(d);
    }
    for (const d of deferred.allDiscoveredDomains) {
      pushDomain(d);
    }
    if (website) {
      pushDomain(website);
    }

    const newDomains = candidateDomains.filter((d) => {
      const h = originHostKey(d);
      return h && !attemptedIrHosts.has(h);
    });
    await runMultiDomainIr(newDomains, ' — after search discovery');
    await runSearchIrFallbackIfNeeded();
  }

  // =========================================================================
  // Step 1b: Search-guessed PDF URLs (after IR crawl — avoids burning rate limits first)
  // =========================================================================
  if (!state.extractionResult.value && searchResult.pdfCandidates.length > 0) {
    log.info(`[${name}] === Step 1b: Search PDF candidates (after IR crawl) ===`);
    const searchAttempt = await tryPdfCandidates(
      searchResult.pdfCandidates, entity, force, 'search',
      MAX_CANDIDATES_PER_STEP, shortNames,
      CIRCUIT_SEARCH_GUESSES,
    );
    if (searchAttempt.success) {
      applyPdfSuccess(state, searchAttempt, 'search');
    } else {
      state.notes.push(...searchAttempt.notes);
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
        CIRCUIT_SEARCH_GUESSES,
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

  let dualTrackAdjudication: PipelineResult['dualTrackAdjudication'];
  const pdfLikeSources: DataSource[] = ['pdf', 'playwright+pdf', 'search+pdf'];
  if (
    state.annualReportText &&
    state.dataSource &&
    pdfLikeSources.includes(state.dataSource) &&
    validationResult.value
  ) {
    const rowStatus = determineStatus(validationResult.value);
    const dt = await runChallengerTrack({
      companyDisplayName: name,
      legalNameForPrompt: entity.legalName,
      ticker: company.ticker ?? null,
      fullPdfText: state.annualReportText,
      pageCount: Math.max(1, state.pdfPageCount || 1),
      suspiciouslyShortPdf: state.suspiciouslyShortPdf,
      validatedData: validationResult.value,
      deterministicFiscalYear: state.fiscalYear,
      fieldExtraction: state.lastFieldExtraction,
      confidence,
      status: rowStatus,
      detectedCompanyType: state.detectedCompanyType,
      forceLlm: Boolean(pipelineOpts?.llmChallengerForce),
    });
    if (dt) {
      dualTrackAdjudication = dt;
      state.notes.push('LLM dual-track adjudication attached (dualTrackAdjudication)');
    }
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
    ...(dualTrackAdjudication ? { dualTrackAdjudication } : {}),
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
