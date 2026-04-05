import { filterAndRankReportCandidatesForEntity } from '../src/discovery/candidate-ranking';
import { buildEntityProfile } from '../src/entity/entity-profile';
import type { CompanyProfile } from '../src/types';
import type { ReportCandidate } from '../src/types';

describe('filterAndRankReportCandidatesForEntity', () => {
  it('drops hostname-collision URLs and boosts org-number-in-url matches', () => {
    const company: CompanyProfile = {
      name: 'Skandinaviska Enskilda Banken AB (publ)',
      legalName: 'Skandinaviska Enskilda Banken AB (publ)',
      ticker: 'SEB-A.ST',
      orgNumber: '502032-9081',
    };
    const profile = buildEntityProfile(company);
    const candidates: ReportCandidate[] = [
      { url: 'https://www.groupeseb.com/x.pdf', score: 100, text: '', source: 'test' },
      {
        url: 'https://www.sebgroup.com/5020329081-annual.pdf',
        score: 80,
        text: '',
        source: 'test',
      },
    ];
    const ranked = filterAndRankReportCandidatesForEntity(candidates, profile);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].url).toContain('sebgroup.com');
    // Base 80 + org-in-url (+5) − high-ambiguity host without distinctive token (−22) = 63
    expect(ranked[0].score).toBe(63);
  });
});
