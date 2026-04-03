// ---------------------------------------------------------------------------
// External source fallback discovery — LAST RESORT tier for PDF discovery.
//
// Fires ONLY when ALL on-site fallbacks (primary scan, deep crawl, direct
// URL construction, sitemap) return zero candidates. This covers companies
// whose sites use client-side JS rendering for all document links.
//
// Ladder: Avanza (d) → AEM CDN patterns (f)
// ---------------------------------------------------------------------------

import * as cheerio from 'cheerio';
import {
  CompanyProfile,
  ReportCandidate,
} from '../types';
import { fetchPage, headCheck } from '../utils/http-client';
import { resolveUrl } from '../utils/url-helpers';
import { createLogger } from '../utils/logger';

const log = createLogger('external-fallback');

const CURRENT_YEAR = new Date().getFullYear();
const RECENT_YEARS = [CURRENT_YEAR, CURRENT_YEAR - 1];

const EXTERNAL_INTER_SOURCE_DELAY_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPdfContentType(ct: string): boolean {
  return ct.includes('application/pdf') || ct.includes('application/octet-stream');
}

// ---------------------------------------------------------------------------
// Slug generators — multiple variants to maximize CDN URL coverage
// ---------------------------------------------------------------------------

function generateSlugs(company: CompanyProfile): string[] {
  const slugs = new Set<string>();

  const nameSlug = company.name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  slugs.add(nameSlug);

  try {
    const hostname = new URL(company.website).hostname;
    const bare = hostname.replace(/^www\./, '');
    const domainSlug = bare.replace(/\.(com|se|net|org|group)$/i, '');
    slugs.add(domainSlug);
    slugs.add(domainSlug.replace(/\./g, '-'));

    // "volvogroup" → "volvo-group"
    const withHyphen = domainSlug.replace(/group$/i, '-group');
    if (withHyphen !== domainSlug) slugs.add(withHyphen);
  } catch { /* ignore */ }

  for (const alias of company.knownAliases) {
    const s = alias
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    if (s.length > 2) slugs.add(s);
  }

  return [...slugs];
}

// ---------------------------------------------------------------------------
// Fallback (d): Avanza.se company page
// ---------------------------------------------------------------------------

async function tryAvanza(
  company: CompanyProfile,
): Promise<ReportCandidate | null> {
  log.info(`[${company.name}] External fallback (d): trying Avanza.se`);

  const tickerEncoded = encodeURIComponent(company.ticker);
  const searchUrl = `https://www.avanza.se/borsdata/sok.html?query=${tickerEncoded}`;

  const searchResult = await fetchPage(searchUrl, 15_000);
  if (!searchResult.ok) {
    log.debug(`[${company.name}] Avanza search failed: ${searchResult.error.message}`);
    return null;
  }

  const $ = cheerio.load(searchResult.response.data);

  // Look for links to company pages (/aktier/om-aktien.html/...)
  const companyPageLinks: string[] = [];
  $('a[href*="om-aktien"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) {
      const resolved = resolveUrl('https://www.avanza.se', href);
      if (resolved) companyPageLinks.push(resolved);
    }
  });

  // Also try searching the page text for company name mentions with links
  $('a[href]').each((_, el) => {
    const text = $(el).text().toLowerCase();
    const nameLower = company.name.toLowerCase();
    if (text.includes(nameLower) && $(el).attr('href')?.includes('/aktier/')) {
      const href = $(el).attr('href')!;
      const resolved = resolveUrl('https://www.avanza.se', href);
      if (resolved && !companyPageLinks.includes(resolved)) {
        companyPageLinks.push(resolved);
      }
    }
  });

  if (companyPageLinks.length === 0) {
    log.debug(`[${company.name}] No company page links found on Avanza`);
    return null;
  }

  log.debug(`[${company.name}] Found ${companyPageLinks.length} Avanza company page link(s)`);

  // Fetch the first company page and look for annual report PDFs
  for (const pageUrl of companyPageLinks.slice(0, 2)) {
    await sleep(EXTERNAL_INTER_SOURCE_DELAY_MS);
    const pageResult = await fetchPage(pageUrl, 15_000);
    if (!pageResult.ok) continue;

    const $page = cheerio.load(pageResult.response.data);
    const pdfCandidates: ReportCandidate[] = [];

    $page('a[href]').each((_, el) => {
      const href = $page(el).attr('href');
      if (!href) return;
      const resolved = resolveUrl(pageUrl, href);
      if (!resolved) return;

      const text = $page(el).text().trim().toLowerCase();
      if (
        /\.pdf(\?|$)/i.test(resolved) &&
        (/annual|årsredovisning|arsredovisning/i.test(text) ||
          /annual|arsredovisning/i.test(resolved))
      ) {
        const yearMatch = resolved.match(/20[12]\d/) || text.match(/20[12]\d/);
        const year = yearMatch ? parseInt(yearMatch[0], 10) : null;
        pdfCandidates.push({
          url: resolved,
          score: 10 + (year && RECENT_YEARS.includes(year) ? 5 : 0),
          text: `[avanza] ${$page(el).text().trim().substring(0, 100)}`,
          source: 'fallback-avanza',
        });
      }
    });

    if (pdfCandidates.length > 0) {
      pdfCandidates.sort((a, b) => b.score - a.score);
      const winner = pdfCandidates[0];
      log.info(`[${company.name}] Avanza hit: ${winner.url}`);
      return winner;
    }
  }

  log.debug(`[${company.name}] No annual report PDFs found on Avanza`);
  return null;
}

// ---------------------------------------------------------------------------
// Fallback (f): AEM CDN URL patterns — HEAD-check common paths
// ---------------------------------------------------------------------------

function buildAemCdnUrls(company: CompanyProfile): string[] {
  const base = company.website.replace(/\/$/, '');
  const slugs = generateSlugs(company);
  const urls: string[] = [];

  for (const year of RECENT_YEARS) {
    for (const slug of slugs) {
      // Common AEM content-dam paths
      urls.push(
        `${base}/content/dam/${slug}/markets/global/en-en/investors/reports-and-presentations/annual-reports/${year}/annual-report-${year}.pdf`,
        `${base}/content/dam/${slug}/markets/master/investors/${year}/${slug}-annual-and-sustainability-report-${year}.pdf`,
        `${base}/content/dam/${slug}/investors/annual-reports/${year}/annual-report-${year}.pdf`,
        `${base}/content/dam/${slug}/investors/${year}/annual-report-${year}.pdf`,
        `${base}/content/dam/${slug}/investors/${year}/${slug}-annual-report-${year}.pdf`,
        `${base}/content/dam/${slug}/${year}/annual-report-${year}.pdf`,
        `${base}/content/dam/${slug}/annual-report-${year}.pdf`,
      );
    }

    // Domain-level paths without slug nesting
    urls.push(
      `${base}/content/dam/annual-report-${year}.pdf`,
      `${base}/content/dam/investors/annual-reports/annual-report-${year}.pdf`,
      `${base}/content/dam/investors/${year}/annual-report-${year}.pdf`,
    );
  }

  return urls;
}

async function tryAemCdnPatterns(
  company: CompanyProfile,
): Promise<ReportCandidate | null> {
  const urls = buildAemCdnUrls(company);
  log.info(
    `[${company.name}] External fallback (f): HEAD-checking ${urls.length} AEM CDN patterns`,
  );

  for (const url of urls) {
    const result = await headCheck(url, 8_000);
    if (!result.exists || result.status !== 200) continue;

    const ct = result.contentType ?? '';
    const finalUrl = result.finalUrl ?? url;

    // Reject redirects to HTML pages
    if (ct.includes('text/html') || (!ct.includes('pdf') && !ct.includes('octet-stream'))) {
      log.debug(`[${company.name}]   ${url} → not PDF (${ct})`);
      continue;
    }

    if (isPdfContentType(ct)) {
      const year = url.match(/20[12]\d/)?.[0];
      log.info(`[${company.name}] AEM CDN hit: ${finalUrl}`);
      return {
        url: finalUrl,
        score: 10 + (year && RECENT_YEARS.includes(parseInt(year, 10)) ? 5 : 0),
        text: `[aem-cdn] annual-report-${year ?? 'unknown'}`,
        source: 'fallback-aem-cdn',
      };
    }
  }

  log.info(`[${company.name}] No AEM CDN patterns matched`);
  return null;
}

// ---------------------------------------------------------------------------
// Main entry point — runs all external fallbacks in sequence
// ---------------------------------------------------------------------------

export async function externalSourceDiscovery(
  company: CompanyProfile,
): Promise<ReportCandidate | null> {
  log.info(
    `[${company.name}] All on-site fallbacks exhausted — starting external source discovery`,
  );

  // (d) Avanza
  const avanzaResult = await tryAvanza(company);
  if (avanzaResult) {
    log.info(`[${company.name}] External source found PDF via Avanza`);
    return avanzaResult;
  }

  await sleep(EXTERNAL_INTER_SOURCE_DELAY_MS);

  // (f) AEM CDN patterns
  const aemResult = await tryAemCdnPatterns(company);
  if (aemResult) {
    log.info(`[${company.name}] External source found PDF via AEM CDN pattern`);
    return aemResult;
  }

  log.warn(`[${company.name}] All external source fallbacks exhausted — no PDF found`);
  return null;
}
