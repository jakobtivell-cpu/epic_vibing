// ---------------------------------------------------------------------------
// Annual report PDF discovery — scored candidate ranking from IR pages.
//
// Pure Cheerio-based scanner: IR page + sub-pages + deep crawl + direct
// URL construction + sitemap. No Playwright or external fallbacks — those
// are orchestrated at the pipeline level.
// ---------------------------------------------------------------------------

import * as cheerio from 'cheerio';
import { Element } from 'domhandler';
import {
  StageResult,
  ReportDiscoveryResult,
  ReportCandidate,
  ConfidenceLevel,
} from '../types';
import { fetchPage, headCheck } from '../utils/http-client';
import { resolveUrl, getPath } from '../utils/url-helpers';
import { createLogger } from '../utils/logger';
import { candidateUrlsOrTextImpliesStaleReport } from './report-candidate-stale-year';

const log = createLogger('report-ranker');

// ---- Year helpers ----

const CURRENT_YEAR = new Date().getFullYear();
const MOST_RECENT_FISCAL_YEAR = CURRENT_YEAR - 1;

function extractYear(text: string): number | null {
  const matches = text.match(/\b(20[12]\d)\b/g);
  if (!matches) return null;
  const years = matches.map(Number);
  return Math.max(...years);
}

function yearScore(year: number | null): number {
  if (year === null) return 0;
  if (year === MOST_RECENT_FISCAL_YEAR || year === CURRENT_YEAR) return 5;
  if (year === MOST_RECENT_FISCAL_YEAR - 1) return 2;
  const age = MOST_RECENT_FISCAL_YEAR - year;
  if (age > 2) return -5 * (age - 2);
  return 0;
}

// ---- Text scoring ----

const TEXT_POSITIVE: { pattern: RegExp; points: number }[] = [
  { pattern: /annual\s+(?:and\s+sustainability\s+)?report/i, points: 10 },
  { pattern: /årsredovisning/i, points: 10 },
  { pattern: /års-?\s*och\s+hållbarhetsredovisning/i, points: 8 },
  { pattern: /\bannual\b/i, points: 3 },
];

const TEXT_NEGATIVE: { pattern: RegExp; points: number }[] = [
  { pattern: /\bQ[1-4]\b/i, points: -10 },
  { pattern: /\binterim\b/i, points: -10 },
  { pattern: /\bquarterly\b/i, points: -10 },
  { pattern: /delårsrapport/i, points: -10 },
  { pattern: /\bgovernance\b/i, points: -8 },
  { pattern: /\bremuneration\b/i, points: -8 },
  { pattern: /\bpresentation\b/i, points: -8 },
  { pattern: /capital\s*markets?\s*day/i, points: -8 },
  { pattern: /\bpress\s*release\b/i, points: -10 },
  { pattern: /\bnews\b/i, points: -8 },
  { pattern: /\bgeneral\s*meeting\b/i, points: -12 },
  { pattern: /\bannual\s+general\s+meeting\b/i, points: -18 },
  { pattern: /\bextraordinary\s+general\b/i, points: -18 },
  { pattern: /\bagm\b/i, points: -14 },
  { pattern: /\bproxy\b/i, points: -14 },
  { pattern: /\bvoting\b/i, points: -22 },
  { pattern: /\bpostal[\s-]*voting\b/i, points: -22 },
  { pattern: /\bpost[\s-]*vote\b/i, points: -18 },
  { pattern: /\bkallelse\b/i, points: -22 },
  { pattern: /\bstämma\b/i, points: -16 },
  { pattern: /\bbolagsstämma\b/i, points: -22 },
  { pattern: /\bbolagsstamma\b/i, points: -20 },
  { pattern: /\bröstmaterial\b/i, points: -20 },
  { pattern: /\bvalberedning/i, points: -12 },
  { pattern: /\bnotice\s+of\s+(?:the\s+)?(?:annual|general|egm)\b/i, points: -18 },
  { pattern: /\binstructions\s+for\s+(?:voting|shareholders)\b/i, points: -16 },
  { pattern: /\bsummary\b/i, points: -3 },
  { pattern: /\bsammandrag\b/i, points: -3 },
  { pattern: /\besef\b/i, points: -3 },
  { pattern: /\bcopy[\s-]+of[\s-]+the[\s-]+official\b/i, points: -5 },
];

function sustainabilityPenalty(text: string): number {
  if (/sustainability|hållbarhet/i.test(text) && !/annual|årsredovisning/i.test(text)) {
    return -5;
  }
  return 0;
}

// ---- URL scoring ----

function urlScore(href: string): number {
  let score = 0;
  const lower = href.toLowerCase();

  if (/\.pdf(\?|$)/i.test(href)) score += 5;
  if (/annual|arsredovisning|årsredovisning/i.test(lower)) score += 4;
  if (/annual-and-sustainability|annual.report|arsredovisning|års-och-hållbarhets/i.test(lower)) {
    score += 3;
  }
  if (/press|\/pr-|\/news\/|pressrelease|_pr_/i.test(lower)) score -= 10;
  if (/interim|quarterly|q[1-4]\b/i.test(lower)) score -= 8;
  if (/voting|postal[\s-]*vote|kallelse|proxy|bolagsst(a|ä)mma|röstmaterial|\/agm\b|_agm_|instruktioner/i.test(lower)) {
    score -= 22;
  }

  const urlYear = extractYear(href);
  if (urlYear !== null) {
    if (urlYear === MOST_RECENT_FISCAL_YEAR || urlYear === CURRENT_YEAR) score += 2;
  }

  return score;
}

// ---- Context scoring ----

function contextScore(
  $: cheerio.CheerioAPI,
  el: Element,
): number {
  let node = $(el).parent();
  for (let depth = 0; depth < 8 && node.length; depth++) {
    const prev = node.prevAll('h1, h2, h3, h4').first();
    if (prev.length) {
      const headingText = prev.text().toLowerCase();
      if (/annual\s*report|årsredovisning/i.test(headingText)) {
        return 3;
      }
    }
    node = node.parent();
  }
  return 0;
}

// ---- Composite scorer ----

function scoreLinkCandidate(
  $: cheerio.CheerioAPI,
  el: Element,
  baseUrl: string,
): ReportCandidate | null {
  const href = $(el).attr('href');
  if (!href) return null;

  const resolved = resolveUrl(baseUrl, href);
  if (!resolved) return null;

  const text = $(el).text().trim().replace(/\s+/g, ' ');
  if (!text && !href) return null;

  if (candidateUrlsOrTextImpliesStaleReport(resolved, text)) return null;

  let score = 0;

  for (const { pattern, points } of TEXT_POSITIVE) {
    if (pattern.test(text)) score += points;
  }
  // Penalize proxy/AGM/voting in link text *or* URL path (many IR lists use empty anchor text).
  const negHaystack = `${text} ${resolved}`.toLowerCase();
  for (const { pattern, points } of TEXT_NEGATIVE) {
    if (pattern.test(negHaystack)) score += points;
  }
  score += sustainabilityPenalty(text);

  const textYear = extractYear(text);
  score += yearScore(textYear);

  score += urlScore(resolved);
  score += contextScore($, el);

  return {
    url: resolved,
    score,
    text: text.substring(0, 150),
    source: 'ir-page',
  };
}

// ---- Helpers ----

function isPdfUrl(url: string): boolean {
  return /\.pdf(\?|$)/i.test(url);
}

const BINARY_EXTENSIONS = /\.(zip|xlsx?|docx?|pptx?|csv|png|jpg|jpeg|gif|svg|mp4|mp3)(\?|$)/i;

function isReportSubPageLink(candidate: ReportCandidate): boolean {
  if (isPdfUrl(candidate.url)) return false;
  if (BINARY_EXTENSIONS.test(candidate.url)) return false;
  const textLower = candidate.text.toLowerCase();
  return (
    /annual\s*report|årsredovisning|financial\s*report/i.test(textLower) ||
    (/\breports?\b/i.test(textLower) && candidate.score >= 5)
  );
}

// ---- Sub-page detection ----

const SUBPAGE_PATTERNS = [
  /\breports?\b/i,
  /\bpublications?\b/i,
  /\bdocuments?\b/i,
  /\barchive\b/i,
  /\bfinancial\s*information\b/i,
  /\brapporter\b/i,
  /\bpublikationer\b/i,
  /\bannual\s*report/i,
  /\bårsredovisning/i,
];

function findSubPageLinks(
  $: cheerio.CheerioAPI,
  baseUrl: string,
  alreadyVisited: Set<string>,
): string[] {
  const links: { url: string; score: number }[] = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;

    const resolved = resolveUrl(baseUrl, href);
    if (!resolved || alreadyVisited.has(resolved)) return;
    if (/\.pdf(\?|$)/i.test(resolved)) return;
    if (BINARY_EXTENSIONS.test(resolved)) return;

    const text = $(el).text().trim().toLowerCase();
    let matchScore = 0;

    for (const pattern of SUBPAGE_PATTERNS) {
      if (pattern.test(text)) matchScore += 5;
    }
    if (/annual/i.test(text)) matchScore += 3;
    if (/investor/i.test(resolved)) matchScore += 2;

    if (/calendar|event|press|news|contact|career|cookie|privacy/i.test(text)) {
      matchScore -= 10;
    }

    if (matchScore >= 5) {
      links.push({ url: resolved, score: matchScore });
    }
  });

  links.sort((a, b) => b.score - a.score);
  return links.slice(0, 5).map((l) => l.url);
}

// ---- Sustainability candidate detection ----

const SUSTAINABILITY_PDF_PATTERNS: RegExp[] = [
  /sustainability\s+report/i,
  /hållbarhetsrapport/i,
  /hållbarhetsredovisning/i,
  /corporate\s+responsibility\s+report/i,
  /esg\s+report/i,
  /climate\s+report/i,
];

function findBestSustainabilityCandidate(
  candidates: ReportCandidate[],
): ReportCandidate | null {
  const minAcceptableYear = MOST_RECENT_FISCAL_YEAR - 1;

  const matches = candidates.filter((c) => {
    if (!isPdfUrl(c.url)) return false;
    if (!SUSTAINABILITY_PDF_PATTERNS.some((p) => p.test(c.text))) return false;
    if (/annual|årsredovisning/i.test(c.text)) return false;

    const year = extractYear(c.text) ?? extractYear(c.url);
    if (year !== null && year < minAcceptableYear) return false;

    return true;
  });

  if (matches.length === 0) return null;

  matches.sort((a, b) => {
    const ya = extractYear(a.text) ?? extractYear(a.url) ?? 0;
    const yb = extractYear(b.text) ?? extractYear(b.url) ?? 0;
    if (yb !== ya) return yb - ya;
    return b.score - a.score;
  });

  return matches[0];
}

// ---- Page scanning ----

function scanPageForCandidates(
  html: string,
  baseUrl: string,
  source: string,
): ReportCandidate[] {
  const $ = cheerio.load(html);
  const candidates: ReportCandidate[] = [];
  const seen = new Set<string>();

  $('a[href]').each((_, el) => {
    const candidate = scoreLinkCandidate($, el, baseUrl);
    if (!candidate) return;
    if (seen.has(candidate.url)) return;
    seen.add(candidate.url);

    candidate.source = source;
    candidates.push(candidate);
  });

  return candidates;
}

// ---- Confidence assessment ----

function assessConfidence(
  candidates: ReportCandidate[],
): { confidence: ConfidenceLevel; explanation: string } {
  if (candidates.length === 0) {
    return { confidence: 'low', explanation: 'No PDF candidates found on IR page or sub-pages' };
  }

  const top = candidates[0];
  const runner = candidates.length > 1 ? candidates[1] : null;

  if (top.score < 8) {
    return {
      confidence: 'low',
      explanation: `Top candidate "${top.text}" scored only ${top.score} — weak signal`,
    };
  }

  if (runner && top.score - runner.score <= 3) {
    return {
      confidence: 'medium',
      explanation: `Top candidate "${top.text}" (${top.score}pts) and runner-up "${runner.text}" (${runner.score}pts) are within 3 points — ambiguous`,
    };
  }

  return {
    confidence: 'high',
    explanation: `Top candidate "${top.text}" (${top.score}pts) leads clearly${runner ? ` over runner-up "${runner.text}" (${runner.score}pts)` : ''}`,
  };
}

// ---- Fiscal year inference ----

function inferFiscalYear(candidate: ReportCandidate): number | null {
  return extractYear(candidate.text) ?? extractYear(candidate.url) ?? null;
}

// ---- Fallback: deep sub-page crawl ----

const REPORT_SUBPAGE_SUFFIXES = [
  'financial-reports',
  'annual-reports',
  'reports',
  'downloads',
  'publications',
  'reports-and-presentations',
  'financial-reports-and-presentations',
  'arsredovisningar',
  'rapporter',
];

function buildSubPageGuesses(
  website: string,
  irPageUrl: string,
): string[] {
  const urls: string[] = [];
  const base = website.replace(/\/$/, '');

  let irDir: string;
  try {
    const parsed = new URL(irPageUrl);
    const path = parsed.pathname.replace(/\.html?$/, '');
    irDir = `${parsed.origin}${path.replace(/\/$/, '')}/`;
  } catch {
    irDir = irPageUrl.replace(/\.html?$/, '/').replace(/\/$/, '') + '/';
  }

  for (const suffix of REPORT_SUBPAGE_SUFFIXES) {
    urls.push(`${irDir}${suffix}`);
    urls.push(`${irDir}${suffix}.html`);
  }

  const sitePaths = [
    '/en/reports',
    '/en/news-and-media/reports',
    '/en/about-us/reports',
    '/reports',
    '/news-and-media/reports',
  ];
  for (const sp of sitePaths) {
    urls.push(`${base}${sp}`);
    urls.push(`${base}${sp}.html`);
  }

  return urls;
}

async function fallbackDeepSubPageCrawl(
  companyName: string,
  website: string,
  irPageUrl: string,
  irPageHtml: string,
  irBaseUrl: string,
  visitedPages: Set<string>,
): Promise<ReportCandidate[]> {
  const candidates: ReportCandidate[] = [];

  const $ir = cheerio.load(irPageHtml);
  const pathBasedSubPages: string[] = [];

  $ir('a[href]').each((_, el) => {
    const href = $ir(el).attr('href');
    if (!href) return;
    const resolved = resolveUrl(irBaseUrl, href);
    if (!resolved || visitedPages.has(resolved)) return;
    if (isPdfUrl(resolved) || BINARY_EXTENSIONS.test(resolved)) return;

    const path = getPath(resolved);
    if (/\/(reports|downloads|publications|annual-reports|financial-reports|rapporter|arsredovisning)/i.test(path)) {
      pathBasedSubPages.push(resolved);
    }
  });

  const guessedUrls = buildSubPageGuesses(website, irPageUrl);

  const allSubPages = [...pathBasedSubPages, ...guessedUrls];
  const seen = new Set<string>(visitedPages);
  const toFetch: string[] = [];

  for (const url of allSubPages) {
    if (!seen.has(url)) {
      seen.add(url);
      toFetch.push(url);
    }
  }

  if (toFetch.length === 0) {
    log.info(`[${companyName}] Fallback deep crawl: no new sub-pages to try`);
    return [];
  }

  log.info(`[${companyName}] Fallback deep crawl: scanning ${toFetch.length} candidate sub-pages`);

  for (const subUrl of toFetch) {
    const result = await fetchPage(subUrl, 10_000);
    if (!result.ok) {
      log.debug(`[${companyName}]   ${subUrl} → ${result.error.status ?? result.error.message}`);
      continue;
    }

    visitedPages.add(subUrl);
    visitedPages.add(result.response.finalUrl);

    const subCandidates = scanPageForCandidates(
      result.response.data,
      result.response.finalUrl,
      'fallback-deep-crawl',
    );

    const pdfHits = subCandidates.filter((c) => isPdfUrl(c.url));
    if (pdfHits.length > 0) {
      log.info(`[${companyName}]   ${subUrl} → ${pdfHits.length} PDF candidates found`);
      candidates.push(...pdfHits);
    } else {
      log.debug(`[${companyName}]   ${subUrl} → 0 PDFs`);
    }
  }

  log.info(`[${companyName}] Fallback deep crawl: ${candidates.length} total PDF candidates`);
  return candidates;
}

// ---- Fallback: direct URL construction ----

function companySlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export function buildCandidateUrls(companyName: string, website: string): string[] {
  const base = website.replace(/\/$/, '');
  const slug = companySlug(companyName);
  const years = [MOST_RECENT_FISCAL_YEAR, CURRENT_YEAR];

  const templates = [
    `${base}/${slug}-annual-report-{year}.pdf`,
    `${base}/${slug}-annual-and-sustainability-report-{year}.pdf`,
    `${base}/investors/annual-report-{year}.pdf`,
    `${base}/investors/${slug}-annual-report-{year}.pdf`,
    `${base}/globalassets/${slug}-annual-report-{year}.pdf`,
    `${base}/annual-report-{year}.pdf`,
    `${base}/annual-report-{year}-en.pdf`,
    `${base}/globalassets/annual-report-{year}.pdf`,
    `${base}/assets/annual-report-{year}.pdf`,
    `${base}/content/dam/${slug}/annual-report-{year}.pdf`,
    `${base}/wp-content/uploads/{year}/${slug}-annual-report-{year}.pdf`,
  ];

  const urls: string[] = [];
  for (const year of years) {
    for (const tmpl of templates) {
      urls.push(tmpl.replace(/\{year\}/g, String(year)));
    }
  }
  return urls;
}

async function fallbackDirectUrls(
  companyName: string,
  website: string,
): Promise<ReportCandidate | null> {
  const urls = buildCandidateUrls(companyName, website);
  log.info(`[${companyName}] Fallback: trying ${urls.length} direct URL patterns`);

  for (const url of urls) {
    const result = await headCheck(url, 8_000);
    if (result.exists && result.status === 200) {
      const ct = result.contentType ?? '';
      const finalUrl = result.finalUrl ?? url;

      const redirectedToHtml =
        ct.includes('text/html') || (!isPdfUrl(finalUrl) && !ct.includes('application/pdf'));
      if (redirectedToHtml) {
        log.debug(`[${companyName}] Fallback: ${url} → redirected to HTML (${finalUrl}) — skipping`);
        continue;
      }

      const confirmedPdf =
        ct.includes('application/pdf') ||
        (ct.includes('application/octet-stream') && isPdfUrl(finalUrl));

      if (confirmedPdf) {
        const year = extractYear(url);
        log.info(`[${companyName}] Fallback hit: ${finalUrl}`);
        return {
          url: finalUrl,
          score: 10 + yearScore(year),
          text: `[direct-url] annual-report-${year ?? 'unknown'}`,
          source: 'fallback-direct-url',
        };
      }
    }
  }

  log.info(`[${companyName}] Fallback: no direct URL patterns matched`);
  return null;
}

// ---- Fallback: sitemap.xml ----

async function fallbackSitemap(
  companyName: string,
  website: string,
): Promise<ReportCandidate | null> {
  const base = website.replace(/\/$/, '');
  const sitemapUrls = [
    `${base}/sitemap.xml`,
    `${base}/sitemap_index.xml`,
  ];

  log.info(`[${companyName}] Fallback: checking sitemap.xml`);

  for (const smUrl of sitemapUrls) {
    const result = await fetchPage(smUrl, 10_000);
    if (!result.ok) continue;

    const xml = result.response.data;
    const childSitemaps = extractSitemapIndexUrls(xml);
    const allXmls = [xml];

    for (const childUrl of childSitemaps) {
      const childResult = await fetchPage(childUrl, 10_000);
      if (childResult.ok) {
        allXmls.push(childResult.response.data);
      }
    }

    for (const sitemapXml of allXmls) {
      const candidate = searchSitemapForReport(sitemapXml, companyName);
      if (candidate) return candidate;
    }
  }

  log.info(`[${companyName}] Fallback: no annual report found in sitemaps`);
  return null;
}

function extractSitemapIndexUrls(xml: string): string[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const urls: string[] = [];
  $('sitemap loc').each((_, el) => {
    const loc = $(el).text().trim();
    if (loc) urls.push(loc);
  });
  return urls.slice(0, 10);
}

function searchSitemapForReport(
  xml: string,
  companyName: string,
): ReportCandidate | null {
  const $ = cheerio.load(xml, { xmlMode: true });
  const candidates: ReportCandidate[] = [];

  $('url loc, loc').each((_, el) => {
    const loc = $(el).text().trim();
    if (!loc) return;

    const path = getPath(loc);
    const isAnnualReport =
      /annual[-_]?report|arsredovisning|årsredovisning/i.test(path);
    if (!isAnnualReport) return;

    const isPdf = /\.pdf(\?|$)/i.test(loc);
    const year = extractYear(loc);
    if (!year || year < MOST_RECENT_FISCAL_YEAR - 1) return;

    let score = isPdf ? 5 : 2;
    score += yearScore(year);
    score += 4;

    candidates.push({
      url: loc,
      score,
      text: `[sitemap] ${path.split('/').pop() ?? loc}`,
      source: 'fallback-sitemap',
    });
  });

  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length > 0) {
    log.info(`[${companyName}] Fallback sitemap hit: ${candidates[0].url} (score ${candidates[0].score})`);
    return candidates[0];
  }

  return null;
}

// ---- Main entry point ----

/**
 * Discover annual report PDF candidates from an IR page using Cheerio.
 * Pure scanner — no Playwright, no external fallbacks. Those are
 * orchestrated at the pipeline level.
 */
export async function discoverAnnualReport(
  companyName: string,
  website: string,
  irPageUrl: string,
): Promise<StageResult<ReportDiscoveryResult>> {
  const startTime = Date.now();
  const visitedPages = new Set<string>();
  visitedPages.add(irPageUrl);

  log.info(`[${companyName}] Scanning IR page for report candidates: ${irPageUrl}`);

  const irResult = await fetchPage(irPageUrl, 10_000);
  if (!irResult.ok) {
    return {
      status: 'failed',
      value: null,
      error: `Failed to fetch IR page: ${irResult.error.message}`,
      durationMs: Date.now() - startTime,
    };
  }

  const irHtml = irResult.response.data;
  const irBaseUrl = irResult.response.finalUrl;
  visitedPages.add(irBaseUrl);

  let allCandidates = scanPageForCandidates(irHtml, irBaseUrl, 'ir-page');
  log.info(`[${companyName}] Found ${allCandidates.length} link candidates on IR page`);

  // --- Collect sub-pages to follow ---
  const subPagesToFollow: string[] = [];

  const $ir = cheerio.load(irHtml);
  const genericSubPages = findSubPageLinks($ir, irBaseUrl, visitedPages);
  for (const url of genericSubPages) {
    if (!visitedPages.has(url)) {
      subPagesToFollow.push(url);
      visitedPages.add(url);
    }
  }

  for (const c of allCandidates) {
    if (!visitedPages.has(c.url) && isReportSubPageLink(c)) {
      subPagesToFollow.push(c.url);
      visitedPages.add(c.url);
    }
  }

  if (subPagesToFollow.length > 0) {
    log.info(`[${companyName}] Following ${subPagesToFollow.length} report sub-pages`);
  }

  for (const subUrl of subPagesToFollow) {
    log.info(`[${companyName}]   → ${subUrl}`);
    const subResult = await fetchPage(subUrl, 10_000);
    if (!subResult.ok) {
      log.debug(`[${companyName}]   Failed: ${subResult.error.message}`);
      continue;
    }
    const subCandidates = scanPageForCandidates(
      subResult.response.data,
      subResult.response.finalUrl,
      'sub-page',
    );
    allCandidates = allCandidates.concat(subCandidates);
    log.debug(`[${companyName}]   Found ${subCandidates.length} candidates on sub-page`);
  }

  // --- Build final candidate list ---
  const dedupMap = new Map<string, ReportCandidate>();
  for (const c of allCandidates) {
    const existing = dedupMap.get(c.url);
    if (!existing || c.score > existing.score) {
      dedupMap.set(c.url, c);
    }
  }

  const allDeduped = Array.from(dedupMap.values());
  const sustainCandidate = findBestSustainabilityCandidate(allDeduped);
  if (sustainCandidate) {
    log.info(`[${companyName}] Sustainability report found: "${sustainCandidate.text}" — ${sustainCandidate.url}`);
  }

  const finalCandidates = Array.from(dedupMap.values()).filter((c) => {
    if (isPdfUrl(c.url)) return true;
    if (c.score >= 25) return true;
    return false;
  });

  finalCandidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aPdf = isPdfUrl(a.url) ? 1 : 0;
    const bPdf = isPdfUrl(b.url) ? 1 : 0;
    return bPdf - aPdf;
  });

  log.info(`[${companyName}] IR page scan: ${finalCandidates.length} PDF candidates found`);
  for (const c of finalCandidates.slice(0, 5)) {
    log.info(`[${companyName}]   ${c.score}pts — "${c.text}" — ${c.url}`);
  }

  // --- Internal fallback ladder (only when primary path found zero PDFs) ---
  let fallbackWinner: ReportCandidate | null = null;

  if (finalCandidates.length === 0) {
    log.info(`[${companyName}] Primary scan found no PDFs — starting fallback ladder`);

    const deepCrawlCandidates = await fallbackDeepSubPageCrawl(
      companyName, website, irPageUrl, irHtml, irBaseUrl, visitedPages,
    );
    if (deepCrawlCandidates.length > 0) {
      deepCrawlCandidates.sort((a, b) => b.score - a.score);
      fallbackWinner = deepCrawlCandidates[0];
      for (const c of deepCrawlCandidates) finalCandidates.push(c);
    }

    if (!fallbackWinner) {
      fallbackWinner = await fallbackDirectUrls(companyName, website);
      if (fallbackWinner) finalCandidates.push(fallbackWinner);
    }

    if (!fallbackWinner) {
      fallbackWinner = await fallbackSitemap(companyName, website);
      if (fallbackWinner) finalCandidates.push(fallbackWinner);
    }

    if (finalCandidates.length > 0) {
      finalCandidates.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const aPdf = isPdfUrl(a.url) ? 1 : 0;
        const bPdf = isPdfUrl(b.url) ? 1 : 0;
        return bPdf - aPdf;
      });
      fallbackWinner = finalCandidates[0];
    } else {
      log.warn(`[${companyName}] All Cheerio-based fallbacks exhausted — no PDFs found`);
    }
  }

  // --- Final result assembly ---
  let { confidence, explanation } = assessConfidence(finalCandidates);

  const winner = finalCandidates.length > 0 ? finalCandidates[0] : null;

  if (winner && fallbackWinner && winner.url === fallbackWinner.url) {
    if (confidence === 'high') confidence = 'medium';
    explanation = `Found via fallback (${fallbackWinner.source}): ${explanation}`;
  }

  if (winner) {
    log.info(`[${companyName}] Selected: "${winner.text}" (${winner.score}pts, ${confidence} confidence)`);
  } else {
    log.error(`[${companyName}] No annual report PDF found`);
  }

  const discoveryResult: ReportDiscoveryResult = {
    annualReportUrl: winner?.url ?? null,
    sustainabilityReportUrl: sustainCandidate?.url ?? null,
    fiscalYear: winner ? inferFiscalYear(winner) : null,
    confidence,
    explanation,
    candidatesConsidered: finalCandidates.length,
    allCandidates: finalCandidates.slice(0, 10),
  };

  if (!winner) {
    return {
      status: 'failed',
      value: discoveryResult,
      error: 'No annual report PDF candidates found after all Cheerio fallbacks',
      durationMs: Date.now() - startTime,
    };
  }

  return {
    status: 'success',
    value: discoveryResult,
    durationMs: Date.now() - startTime,
  };
}
