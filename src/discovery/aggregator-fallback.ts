import * as cheerio from 'cheerio';
import { fetchPage } from '../utils/http-client';
import { createLogger } from '../utils/logger';
import { resolveUrl } from '../utils/url-helpers';
import { ReportCandidate } from '../types';

const log = createLogger('aggregator-fallback');

const TRUSTED_AGGREGATOR_HOSTS = [
  'mfn.se',
  'storage.mfn.se',
  'nasdaq.com',
  'news.cision.com',
  'cision.com',
];

function hostAllowed(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return TRUSTED_AGGREGATOR_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function baseScore(text: string, url: string): number {
  const hay = `${text} ${url}`.toLowerCase();
  let score = 3;
  if (/annual\s+(and\s+sustainability\s+)?report|årsredovisning|arsredovisning/.test(hay)) score += 10;
  if (/q[1-4]\b|quarterly|interim|delårsrapport/.test(hay)) score -= 12;
  if (/governance|bolagsstyrning|remuneration|nomination/.test(hay)) score -= 14;
  return score;
}

export async function fetchAggregatorPdfCandidates(
  companyName: string,
  seedUrls: string[],
): Promise<ReportCandidate[]> {
  const out: ReportCandidate[] = [];
  const seen = new Set<string>();

  for (const seed of seedUrls) {
    if (!hostAllowed(seed)) {
      log.warn(`[${companyName}] Ignoring untrusted aggregator host: ${seed}`);
      continue;
    }

    if (/\.pdf(\?|$)/i.test(seed)) {
      if (!seen.has(seed)) {
        seen.add(seed);
        out.push({
          url: seed,
          score: baseScore('aggregator-direct', seed),
          text: '[aggregator] direct pdf',
          source: 'aggregator',
        });
      }
      continue;
    }

    const page = await fetchPage(seed, 10_000);
    if (!page.ok) continue;

    const html = page.response.data;
    const base = page.response.finalUrl;
    const $ = cheerio.load(html);
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const abs = resolveUrl(base, href);
      if (!abs || !/\.pdf(\?|$)/i.test(abs)) return;
      if (!hostAllowed(abs)) return;
      if (seen.has(abs)) return;
      seen.add(abs);
      const text = $(el).text().trim().replace(/\s+/g, ' ');
      out.push({
        url: abs,
        score: baseScore(text, abs),
        text: `[aggregator] ${text || abs}`,
        source: 'aggregator',
      });
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}

