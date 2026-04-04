import { buildCandidateUrls } from '../src/discovery/report-ranker';

describe('buildCandidateUrls', () => {
  it('includes slug-based and year placeholders resolved for recent years', () => {
    const urls = buildCandidateUrls('H&M', 'https://hmgroup.com');
    expect(urls.some((u) => u.includes('hmgroup.com'))).toBe(true);
    expect(urls.some((u) => /h-m|annual-report/i.test(u))).toBe(true);
    expect(urls.every((u) => /\d{4}/.test(u))).toBe(true);
  });

  it('generates slug-based URLs for Volvo', () => {
    const urls = buildCandidateUrls('Volvo', 'https://www.volvogroup.com');
    expect(urls.length).toBeGreaterThan(5);
    expect(urls.some((u) => u.includes('volvogroup.com'))).toBe(true);
    expect(urls.some((u) => u.includes('volvo'))).toBe(true);
  });
});
