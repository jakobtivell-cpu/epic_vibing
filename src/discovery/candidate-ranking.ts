// ---------------------------------------------------------------------------
// Entity-aware adjustments to report PDF candidate scores.
// Complements generic text/url scoring in report-ranker and search-discovery.
// ---------------------------------------------------------------------------

import { ReportCandidate } from '../types';
import type { EntityProfile } from '../entity/entity-profile';
import { shouldRejectReportUrl } from '../entity/entity-profile';
import { candidateUrlsOrTextImpliesStaleReport } from './report-candidate-stale-year';

/**
 * Drop candidates that fail hostname collision rules, then re-rank by score.
 */
export function filterAndRankReportCandidatesForEntity(
  candidates: ReportCandidate[],
  profile: EntityProfile,
): ReportCandidate[] {
  const kept: ReportCandidate[] = [];
  for (const c of candidates) {
    if (shouldRejectReportUrl(c.url, profile)) continue;
    if (candidateUrlsOrTextImpliesStaleReport(c.url, c.text)) continue;
    kept.push({
      ...c,
      score: c.score + entityUrlScoreAdjustment(c.url, profile),
    });
  }
  kept.sort((a, b) => b.score - a.score);
  return kept;
}

function entityUrlScoreAdjustment(url: string, profile: EntityProfile): number {
  let adj = 0;
  let hostname = '';
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return 0;
  }

  const tokens = profile.distinctiveTokens;
  if (profile.ambiguityLevel === 'high' && tokens.length > 0) {
    const hit = tokens.some((t) => t.length >= 5 && hostname.includes(t.toLowerCase()));
    if (!hit) adj -= 22;
    else adj += 8;
  } else if (tokens.length > 0) {
    const hit = tokens.some((t) => t.length >= 6 && hostname.includes(t.toLowerCase()));
    if (hit) adj += 4;
  }

  const orgDigits = profile.orgNumber?.replace(/\D/g, '') ?? '';
  if (orgDigits.length >= 8 && url.toLowerCase().includes(orgDigits)) {
    adj += 5;
  }

  return adj;
}
