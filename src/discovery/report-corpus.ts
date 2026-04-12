// ---------------------------------------------------------------------------
// Report corpus discovery — generic publication / archive hub URLs.
// Extends single IR-page discovery by probing common report-centre paths.
// ---------------------------------------------------------------------------

import { fetchPage } from '../utils/http-client';
import { createLogger } from '../utils/logger';

const log = createLogger('report-corpus');

/** Paths commonly used for annual reports, presentations, and archives (generic). */
const PUBLICATION_HUB_PATHS: string[] = [
  '/investor-relations/reports-and-publications',
  '/investor-relations/reports-and-presentations',
  '/investor-relations/financial-reports',
  '/investors/reports',
  '/investors/financial-reports',
  '/our-offering/reports-and-publications',
  '/en/investor-relations/reports-and-publications',
  '/en/investors/reports',
  '/about/investors/reports',
  '/investor-relations/annual-reports',
  '/investors/annual-reports',
  '/reports-and-publications',
  '/financial-reports',
];

function originFromDomainUrl(domainUrl: string): string {
  const u = domainUrl.replace(/\/$/, '');
  try {
    const parsed = new URL(u.startsWith('http') ? u : `https://${u}`);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return u.startsWith('http') ? u : `https://${u}`;
  }
}

/**
 * Return hub URLs that respond OK (generic corpus seeds, not link enumeration).
 * @param maxPathsToProbe — cap probes per domain to avoid long 429 storms on strict hosts.
 */
export async function collectPublicationHubUrls(
  domainUrl: string,
  maxPathsToProbe: number = 8,
): Promise<string[]> {
  const origin = originFromDomainUrl(domainUrl);
  const found: string[] = [];
  const paths = PUBLICATION_HUB_PATHS.slice(0, Math.max(1, maxPathsToProbe));

  for (const path of paths) {
    const url = `${origin}${path}`;
    try {
      const result = await fetchPage(url, 10_000);
      if (result.ok) {
        found.push(url);
        log.debug(`Report corpus hub OK: ${url}`);
      }
    } catch {
      /* ignore */
    }
  }

  return [...new Set(found)];
}
