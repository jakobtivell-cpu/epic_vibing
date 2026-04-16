import { extractFields } from '../src/extraction/field-extractor';

describe('Fiscal year — deep document anchors', () => {
  it('finds year from period-end phrasing past the cover window', () => {
    const filler = '\n'.repeat(400);
    const text = `
Annual and sustainability report
${filler}
Consolidated financial statements
For the year ended 31 December 2024
Amounts in SEK m
Net sales 1,000
`;
    const r = extractFields(text, 'Example AB', null);
    expect(r.data.fiscal_year).toBe(2024);
  });

  it('finds Swedish closing-date wording deep in the PDF text', () => {
    const filler = 'x'.repeat(12_000);
    const text = `
${filler}
Koncernens resultaträkning
År avslutat den 31 december 2025
Nettoomsättning 500
`;
    const r = extractFields(text, 'Example AB', null);
    expect(r.data.fiscal_year).toBe(2025);
  });
});
