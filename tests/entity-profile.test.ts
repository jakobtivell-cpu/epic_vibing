import { buildEntityProfile, shouldRejectReportUrl } from '../src/entity/entity-profile';
import type { CompanyProfile } from '../src/types';

describe('buildEntityProfile', () => {
  it('uses legal name as search anchor when provided', () => {
    const c: CompanyProfile = {
      name: 'Skandinaviska Enskilda Banken AB (publ)',
      legalName: 'Skandinaviska Enskilda Banken AB (publ)',
      ticker: 'SEB-A.ST',
      orgNumber: '502032-9081',
    };
    const e = buildEntityProfile(c);
    expect(e.searchAnchor).toBe('Skandinaviska Enskilda Banken AB (publ)');
    expect(e.ambiguityLevel).toBe('high');
    expect(e.distinctiveTokens).toContain('skandinaviska');
    expect(e.distinctiveTokens).toContain('enskilda');
  });

  it('marks low ambiguity for long ticker base', () => {
    const c: CompanyProfile = {
      name: 'Sandvik AB (publ)',
      ticker: 'SAND.ST',
    };
    const e = buildEntityProfile(c);
    expect(e.ambiguityLevel).toBe('low');
  });
});

describe('shouldRejectReportUrl', () => {
  it('rejects groupeseb host when legal name matches bank pattern from data file', () => {
    const c: CompanyProfile = {
      name: 'Skandinaviska Enskilda Banken AB (publ)',
      legalName: 'Skandinaviska Enskilda Banken AB (publ)',
      ticker: 'SEB-A.ST',
    };
    const e = buildEntityProfile(c);
    expect(shouldRejectReportUrl('https://www.groupeseb.com/fr/foo.pdf', e)).toBe(true);
    expect(shouldRejectReportUrl('https://sebgroup.com/x.pdf', e)).toBe(false);
  });
});
