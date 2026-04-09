import { scoreEmbeddedPdfUrl } from '../src/discovery/report-ranker';

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
});
