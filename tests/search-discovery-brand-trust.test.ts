import {
  extractBrandSlugsForDomains,
  hostnameMatchesBrandTrust,
  mergeBankTickerSlugForTrust,
} from '../src/discovery/search-discovery';

describe('search discovery brand trust', () => {
  it('does not use generic "equity" slug for Bure Equity', () => {
    const slugs = extractBrandSlugsForDomains('Bure Equity AB (publ)');
    expect(slugs).toContain('bure');
    expect(slugs).not.toContain('equity');
    expect(hostnameMatchesBrandTrust('www.bure.se', slugs)).toBe(true);
    expect(hostnameMatchesBrandTrust('www.equity.com', slugs)).toBe(false);
  });

  it('adds ticker-root trust slug only for banks', () => {
    const base = extractBrandSlugsForDomains('Skandinaviska Enskilda Banken AB (publ)');
    const merged = mergeBankTickerSlugForTrust('Skandinaviska Enskilda Banken AB (publ)', 'SEB-A.ST', base);
    expect(merged).toContain('seb');
    expect(hostnameMatchesBrandTrust('www.sebgroup.com', merged)).toBe(true);
  });

  it('does not treat "International" as a brand slug for Lindab International', () => {
    const slugs = extractBrandSlugsForDomains('Lindab International AB (publ)');
    expect(slugs).toContain('lindab');
    expect(slugs).toContain('lindabgroup');
    expect(slugs).not.toContain('international');
    expect(hostnameMatchesBrandTrust('www.international.com', slugs)).toBe(false);
    expect(hostnameMatchesBrandTrust('www.lindabgroup.com', slugs)).toBe(true);
  });
});

