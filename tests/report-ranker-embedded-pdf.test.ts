import {
  classifyReportCandidateClass,
  rankReportCandidatesForSelection,
  scoreEmbeddedPdfUrl,
} from '../src/discovery/report-ranker';

describe('report-ranker embedded PDF scoring', () => {
  const baseUrl = 'https://eqtgroup.com/en/shareholders/reports-and-presentations';
  const sanityPdf =
    'https://cdn.sanity.io/files/30p7so6x/eqt-public-web-prod/7675f7f0a9631e314b49760fb58d89d276ecb887.pdf';

  it('crushes opaque Sanity PDFs without annual-report context', () => {
    const html = `<script>{"file":"${sanityPdf}"}</script>`;
    const idx = html.indexOf(sanityPdf);
    const raw = 8;
    expect(scoreEmbeddedPdfUrl(sanityPdf, raw, html, idx, baseUrl)).toBeLessThanOrEqual(1);
  });

  it('keeps Sanity PDFs when nearby JSON mentions annual report', () => {
    const html = `"label":"Annual and Sustainability report 2025","url":"${sanityPdf}"`;
    const idx = html.indexOf(sanityPdf);
    const raw = 8;
    expect(scoreEmbeddedPdfUrl(sanityPdf, raw, html, idx, baseUrl)).toBeGreaterThan(raw);
  });

  it('does not penalize same-site PDFs', () => {
    const pdf = 'https://eqtgroup.com/media/annual-report-2025.pdf';
    const html = `<a href="${pdf}">x</a>`;
    const idx = html.indexOf(pdf);
    expect(scoreEmbeddedPdfUrl(pdf, 12, html, idx, baseUrl)).toBe(12);
  });

  it('classifies policy/governance PDFs as non-annual-like', () => {
    expect(
      classifyReportCandidateClass(
        'Corporate governance report 2025',
        'https://example.com/files/corporate-governance-report-2025.pdf',
      ),
    ).toBe('non_annual_like');
  });

  it('classifies year-in-brief PDFs as non-annual-like', () => {
    expect(
      classifyReportCandidateClass(
        'Year in Brief 2025',
        'https://example.com/files/year-in-brief-2025.pdf',
      ),
    ).toBe('non_annual_like');
  });

  it('prefers annual report over higher-scoring governance/policy candidates', () => {
    const ranked = rankReportCandidatesForSelection([
      {
        url: 'https://example.com/governance-report-2025.pdf',
        score: 40,
        text: 'Corporate governance report 2025',
        source: 'ir-page',
      },
      {
        url: 'https://example.com/policy-update-2025.pdf',
        score: 45,
        text: 'Policy update 2025',
        source: 'ir-page',
      },
      {
        url: 'https://example.com/annual-report-2025.pdf',
        score: 20,
        text: 'Annual report 2025',
        source: 'ir-page',
      },
    ]);

    expect(ranked[0].url).toContain('annual-report-2025.pdf');
  });

  it('prefers annual report over year-in-brief candidate', () => {
    const ranked = rankReportCandidatesForSelection([
      {
        url: 'https://example.com/year-in-brief-2025.pdf',
        score: 41,
        text: 'Year in Brief 2025',
        source: 'ir-page',
      },
      {
        url: 'https://example.com/annual-report-2025.pdf',
        score: 18,
        text: 'Annual report 2025',
        source: 'ir-page',
      },
    ]);

    expect(ranked[0].url).toContain('annual-report-2025.pdf');
  });
});
