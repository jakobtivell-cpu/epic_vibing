// ---------------------------------------------------------------------------
// Playwright fallback — Step 3 in the generic fallback chain.
//
// Uses a full browser to render JS-heavy IR pages and extract PDF links
// from the DOM and network responses. Generic — no company-specific logic.
// If Playwright is not installed, skips gracefully and returns [].
// ---------------------------------------------------------------------------

import { ReportCandidate, SOURCE_PLAYWRIGHT_FALLBACK } from '../types';
import { createLogger } from '../utils/logger';

const log = createLogger('playwright');

const CURRENT_YEAR = new Date().getFullYear();
const RECENT_FISCAL_YEAR = CURRENT_YEAR - 1;

interface PageLink {
  href: string;
  text: string;
}

const SUBPAGE_PATTERNS = [
  /annual[-\s]?reports?/i,
  /financial[-\s]?reports?/i,
  /reports[-\s](?:and|&)[-\s]presentations?/i,
  /årsredovisning/i,
  /rapporter/i,
];

function scorePdfUrl(href: string): number {
  if (!/\.pdf(\?|$)/i.test(href)) return -999;

  let score = 4;
  const hrefLower = href.toLowerCase();

  if (/annual\s*(?:and\s*sustainability)?\s*report|arsredovisning|årsredovisning|annual-report/i.test(hrefLower)) {
    score += 8;
  }
  if (/press|\/pr-|\/news\/|pressrelease|_pr_/i.test(hrefLower)) score -= 10;
  if (/interim|quarterly|q[1-4]/i.test(hrefLower)) score -= 10;
  if (/governance|remuneration|presentation/i.test(hrefLower)) score -= 6;

  const yearMatch = href.match(/\b(20[12]\d)\b/);
  if (yearMatch) {
    const year = parseInt(yearMatch[1], 10);
    if (year === RECENT_FISCAL_YEAR || year === CURRENT_YEAR) score += 5;
    else if (year === RECENT_FISCAL_YEAR - 1) score += 2;
    else if (year < RECENT_FISCAL_YEAR - 2) score -= 5 * (RECENT_FISCAL_YEAR - year - 2);
  }

  return score;
}

function scoreLink(href: string, text: string): number {
  if (!/\.pdf(\?|$)/i.test(href)) return -999;

  let score = 5;
  const textLower = text.toLowerCase();
  const hrefLower = href.toLowerCase();

  if (/annual\s+(?:and\s+sustainability\s+)?report/i.test(textLower)) score += 10;
  if (/årsredovisning/i.test(textLower)) score += 10;
  if (/annual|arsredovisning|årsredovisning/i.test(hrefLower)) score += 4;
  if (/annual-and-sustainability|annual.report|arsredovisning|årsredovisning/i.test(hrefLower)) {
    score += 3;
  }

  if (/press|\/pr-|\/news\/|pressrelease/i.test(hrefLower)) score -= 8;
  if (/Q[1-4]/i.test(textLower)) score -= 10;
  if (/interim|quarterly|delårsrapport/i.test(textLower)) score -= 10;
  if (/governance|remuneration|presentation/i.test(textLower)) score -= 8;
  if (/press\s*release|news/i.test(textLower)) score -= 8;
  if (/voting|postal[\s-]*voting/i.test(textLower)) score -= 15;
  if (/kallelse|bolagsstämma|stämma/i.test(textLower)) score -= 15;
  if (/\bagm\b/i.test(textLower)) score -= 8;
  if (/\bproxy\b/i.test(textLower)) score -= 8;
  if (/summary|sammandrag/i.test(textLower)) score -= 3;

  if (/sustainability|hållbarhet/i.test(textLower) && !/annual|årsredovisning/i.test(textLower)) {
    score -= 5;
  }

  const yearMatch = text.match(/\b(20[12]\d)\b/) || href.match(/\b(20[12]\d)\b/);
  if (yearMatch) {
    const year = parseInt(yearMatch[1], 10);
    if (year === RECENT_FISCAL_YEAR || year === CURRENT_YEAR) score += 5;
    else if (year === RECENT_FISCAL_YEAR - 1) score += 2;
    else if (year < RECENT_FISCAL_YEAR - 2) score -= 5 * (RECENT_FISCAL_YEAR - year - 2);
  }

  return score;
}

function isReportSubPageLink(href: string, text: string): boolean {
  if (/\.pdf(\?|$)/i.test(href)) return false;
  if (/\.(zip|xlsx?|docx?|pptx?|csv|png|jpg|jpeg|gif|svg|mp4)(\?|$)/i.test(href)) return false;
  const combined = text + ' ' + href;
  return SUBPAGE_PATTERNS.some((p) => p.test(combined));
}

async function extractLinksFromPage(page: any, baseUrl: string): Promise<PageLink[]> {
  const raw: Array<{ href: string; text: string }> = await page.evaluate(`(() => {
    const els = document.querySelectorAll('a[href], [href]');
    return Array.from(els).map(el => ({
      href: el.getAttribute('href') || '',
      text: (el.textContent || '').trim().replace(/\\s+/g, ' '),
    }));
  })()`);

  return raw
    .map((r) => {
      let href = r.href;
      if (href.startsWith('/')) {
        try {
          href = new URL(href, baseUrl).href;
        } catch { /* ignore */ }
      }
      return { href, text: r.text };
    })
    .filter((r) => r.href.startsWith('http'));
}

const GOTO_TIMEOUT_MS = 25_000;

async function gotoWithRetry(page: any, url: string, companyName: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: GOTO_TIMEOUT_MS });
  } catch {
    log.debug(`[${companyName}] Playwright: networkidle timed out for ${url} — retrying with domcontentloaded`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
    await page.waitForTimeout(2_500);
  }
}

function attachPdfResponseCollector(page: any, seen: Set<string>): void {
  page.on('response', (response: { url: () => string; headers: () => Record<string, string> }) => {
    try {
      const url = response.url();
      if (!url.startsWith('http')) return;
      const ct = (response.headers()['content-type'] || '').toLowerCase();
      const looksPdf =
        /\.pdf(\?|$)/i.test(url) ||
        ct.includes('application/pdf') ||
        (ct.includes('application/octet-stream') && /\.pdf(\?|$)/i.test(url.split('?')[0]));
      if (!looksPdf || ct.includes('text/html')) return;
      seen.add(url.split('#')[0]);
    } catch {
      /* ignore */
    }
  });
}

/**
 * Use Playwright to render JS-heavy pages and extract PDF links.
 * Returns an empty array if Playwright is not installed.
 */
export async function tryPlaywrightFallback(
  companyName: string,
  irPageUrl: string,
): Promise<ReportCandidate[]> {
  let chromium: any;
  try {
    // @ts-ignore — playwright is an optional dependency
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch {
    log.info(`[${companyName}] Playwright not installed — skipping JS-rendered fallback`);
    return [];
  }

  log.info(`[${companyName}] Falling back to Playwright for JS-rendered content`);

  let browser: any = null;
  try {
    try {
      browser = await chromium.launch({ channel: 'chrome', headless: true });
    } catch {
      browser = await chromium.launch({ headless: true });
    }
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    const networkPdfUrls = new Set<string>();
    attachPdfResponseCollector(page, networkPdfUrls);

    await gotoWithRetry(page, irPageUrl, companyName);
    await page.waitForTimeout(2_000);

    let allLinks = await extractLinksFromPage(page, irPageUrl);
    log.info(`[${companyName}] Playwright: ${allLinks.length} links found on IR page`);

    const pdfCandidates: ReportCandidate[] = [];
    const seenPdfs = new Set<string>();

    for (const link of allLinks) {
      if (seenPdfs.has(link.href)) continue;
      seenPdfs.add(link.href);

      const s = scoreLink(link.href, link.text);
      if (s > 0) {
        pdfCandidates.push({
          url: link.href,
          score: s,
          text: `[playwright] ${link.text.substring(0, 100)}`,
          source: SOURCE_PLAYWRIGHT_FALLBACK,
        });
      }
    }

    for (const pdfUrl of networkPdfUrls) {
      if (seenPdfs.has(pdfUrl)) continue;
      seenPdfs.add(pdfUrl);
      const s = scorePdfUrl(pdfUrl);
      if (s > 0) {
        pdfCandidates.push({
          url: pdfUrl,
          score: s,
          text: `[playwright-network] ${pdfUrl.substring(0, 120)}`,
          source: SOURCE_PLAYWRIGHT_FALLBACK,
        });
      }
    }

    if (pdfCandidates.length === 0) {
      const visitedPages = new Set<string>([irPageUrl]);
      const dedupSubUrls = new Set<string>();
      const subPageLinks = allLinks
        .filter((l) => {
          if (visitedPages.has(l.href) || dedupSubUrls.has(l.href)) return false;
          const match =
            isReportSubPageLink(l.href, l.text) ||
            (/annual.report/i.test((l.text + ' ' + l.href).toLowerCase()) &&
              !/\.pdf/i.test(l.href));
          if (match) dedupSubUrls.add(l.href);
          return match;
        })
        .slice(0, 5);

      for (const subLink of subPageLinks) {
        visitedPages.add(subLink.href);

        log.info(`[${companyName}] Playwright: following sub-page "${subLink.text}" → ${subLink.href}`);

        try {
          await gotoWithRetry(page, subLink.href, companyName);
          await page.waitForTimeout(1_500);

          const subLinks = await extractLinksFromPage(page, subLink.href);
          for (const sl of subLinks) {
            if (seenPdfs.has(sl.href)) continue;
            seenPdfs.add(sl.href);

            const s = scoreLink(sl.href, sl.text);
            if (s > 0) {
              pdfCandidates.push({
                url: sl.href,
                score: s,
                text: `[playwright-sub] ${sl.text.substring(0, 100)}`,
                source: SOURCE_PLAYWRIGHT_FALLBACK,
              });
            }
          }
          for (const pdfUrl of networkPdfUrls) {
            if (seenPdfs.has(pdfUrl)) continue;
            seenPdfs.add(pdfUrl);
            const s = scorePdfUrl(pdfUrl);
            if (s > 0) {
              pdfCandidates.push({
                url: pdfUrl,
                score: s - 1,
                text: `[playwright-network-sub] ${pdfUrl.substring(0, 120)}`,
                source: SOURCE_PLAYWRIGHT_FALLBACK,
              });
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.debug(`[${companyName}] Playwright sub-page failed: ${subLink.href} → ${msg}`);
        }
      }
    }

    await browser.close();
    browser = null;

    pdfCandidates.sort((a, b) => b.score - a.score);

    if (pdfCandidates.length > 0) {
      log.info(`[${companyName}] Playwright found ${pdfCandidates.length} PDF candidate(s)`);
      for (const c of pdfCandidates.slice(0, 5)) {
        log.info(`[${companyName}]   ${c.score}pts — "${c.text}" — ${c.url}`);
      }
    } else {
      log.info(`[${companyName}] Playwright found no PDF candidates`);
    }

    return pdfCandidates;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[${companyName}] Playwright fallback error: ${message}`);
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore cleanup errors */
      }
    }
    return [];
  }
}
