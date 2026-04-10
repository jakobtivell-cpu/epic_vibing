import * as cheerio from 'cheerio';
import { fetchPage } from '../utils/http-client';
import { createLogger } from '../utils/logger';
import { resolveUrl } from '../utils/url-helpers';
import { ReportCandidate } from '../types';

const log = createLogger('cms-api');

function extractYears(text: string): number | null {
  const m = text.match(/\b(20[12]\d)\b/g);
  if (!m) return null;
  return Math.max(...m.map(Number));
}

function scoreFromContext(context: string, url: string): number {
  const hay = `${context} ${url}`.toLowerCase();
  let score = 4;
  if (/annual\s+(and\s+sustainability\s+)?report|årsredovisning|arsredovisning/.test(hay)) score += 10;
  if (/sustainability|hållbarhet/.test(hay) && !/annual|årsredovisning|arsredovisning/.test(hay)) score -= 5;
  if (/q[1-4]\b|quarterly|interim|delårsrapport/.test(hay)) score -= 12;
  if (/governance|bolagsstyrning|remuneration|nomination|board\s+proposal/.test(hay)) score -= 16;
  const y = extractYears(hay);
  if (y !== null) {
    const curr = new Date().getFullYear();
    if (y === curr || y === curr - 1) score += 4;
    else if (y < curr - 3) score -= 8;
  }
  return score;
}

function collectPdfUrlsFromJson(value: unknown, out: Array<{ url: string; context: string }>, context = ''): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (/https?:\/\/[^\s"'<>]+\.pdf(?:\?[^\s"'<>]*)?/i.test(value)) {
      const m = value.match(/https?:\/\/[^\s"'<>]+\.pdf(?:\?[^\s"'<>]*)?/gi) ?? [];
      for (const url of m) out.push({ url, context });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPdfUrlsFromJson(item, out, context);
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const nextCtx = `${context} ${k}`.trim();
      collectPdfUrlsFromJson(v, out, nextCtx);
    }
  }
}

function collectPdfUrlsFromHtml(html: string, baseUrl: string): Array<{ url: string; context: string }> {
  const $ = cheerio.load(html);
  const out: Array<{ url: string; context: string }> = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const abs = resolveUrl(baseUrl, href);
    if (!abs || !/\.pdf(\?|$)/i.test(abs)) return;
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    out.push({ url: abs, context: text });
  });
  return out;
}

export async function fetchCmsApiPdfCandidates(
  companyName: string,
  apiUrls: string[],
): Promise<ReportCandidate[]> {
  const out: ReportCandidate[] = [];
  const seen = new Set<string>();

  for (const apiUrl of apiUrls) {
    const result = await fetchPage(apiUrl, 10_000);
    if (!result.ok) {
      log.warn(`[${companyName}] CMS API fetch failed: ${apiUrl}`);
      continue;
    }

    const finalUrl = result.response.finalUrl;
    const raw = result.response.data;
    const asString = typeof raw === 'string' ? raw : JSON.stringify(raw);
    let found: Array<{ url: string; context: string }> = [];

    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      collectPdfUrlsFromJson(parsed, found, 'cms-json');
    } catch {
      // Not JSON: parse anchors + raw URL fragments from HTML/script payloads.
      found = collectPdfUrlsFromHtml(asString, finalUrl);
      const direct = asString.match(/https?:\/\/[^\s"'<>]+?\.pdf(?:\?[^\s"'<>]*)?/gi) ?? [];
      for (const url of direct) found.push({ url, context: 'cms-embedded' });
    }

    for (const item of found) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      out.push({
        url: item.url,
        score: scoreFromContext(item.context, item.url),
        text: `[cms-api] ${item.context || item.url}`,
        source: 'cms-api',
      });
    }
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}

