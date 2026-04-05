import type { EntityProfile } from '../src/entity/entity-profile';
import { buildEntityCheckTerms, verifyEntityInPdf } from '../src/validation/post-download-checks';

const hmLikeProfile = (): EntityProfile => ({
  displayName: 'H&M',
  legalName: 'H & M Hennes & Mauritz AB (publ)',
  ticker: 'HM B',
  orgNumber: null,
  searchAnchor: 'H & M Hennes & Mauritz AB (publ)',
  canonicalNames: [],
  aliasNamesLowTrust: [],
  distinctiveTokens: ['hennes', 'mauritz'],
  ambiguityLevel: 'high',
  reportingModelHint: 'unspecified',
  hostnameRejectRules: [],
  seedCandidateDomains: [],
  seedIrPage: null,
  knownAliases: [],
});

describe('post-download entity verification', () => {
  it('includes ampersand brand fragments (H&M) as standalone needles', () => {
    const terms = buildEntityCheckTerms(hmLikeProfile());
    expect(terms.some((t) => t.needle === 'H&M')).toBe(true);
  });

  it('accepts PDF front matter that only says H&M Group (high ambiguity, no Hennes/Mauritz)', () => {
    const text = `${'H&M Group — annual report 2025\n'.repeat(400)}`;
    const r = verifyEntityInPdf(text, hmLikeProfile());
    expect(r.passed).toBe(true);
    expect(r.matchedTerm).toContain('H&M');
  });
});
