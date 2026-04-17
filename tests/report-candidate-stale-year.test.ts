import { candidateUrlsOrTextImpliesStaleReport } from '../src/discovery/report-candidate-stale-year';

describe('candidateUrlsOrTextImpliesStaleReport', () => {
  it('flags old 20xx years as stale', () => {
    expect(
      candidateUrlsOrTextImpliesStaleReport(
        'https://example.com/annual-report-2019.pdf',
        'Annual report',
        2026,
      ),
    ).toBe(true);
  });

  it('keeps recent 20xx years', () => {
    expect(
      candidateUrlsOrTextImpliesStaleReport(
        'https://example.com/annual-report-2025.pdf',
        'Annual report',
        2026,
      ),
    ).toBe(false);
  });

  it('flags stale short year range tokens', () => {
    expect(
      candidateUrlsOrTextImpliesStaleReport(
        'https://example.com/annual-report-09-10.pdf',
        'PDF',
        2026,
      ),
    ).toBe(true);
  });

  it('flags stale concatenated short ranges', () => {
    expect(
      candidateUrlsOrTextImpliesStaleReport(
        'https://example.com/Annual-Report-1213.pdf',
        'PDF',
        2026,
      ),
    ).toBe(true);
  });

  it('does not flag recent short range tokens', () => {
    expect(
      candidateUrlsOrTextImpliesStaleReport(
        'https://example.com/annual-report-24-25.pdf',
        'Annual report',
        2026,
      ),
    ).toBe(false);
  });
});
