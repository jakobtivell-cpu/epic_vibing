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

  it('matches "financial year" and US-style month-day order in period-end anchors', () => {
    const filler = '\n'.repeat(400);
    const text = `
${filler}
Consolidated income statement
For the financial year ended December 31, 2024
Amounts in SEK m
Net sales 1,000
`;
    const r = extractFields(text, 'Example AB', null);
    expect(r.data.fiscal_year).toBe(2024);
  });

  it('matches Swedish räkenskapsåret som avslutades deep in the document', () => {
    const filler = 'x'.repeat(20_000);
    const text = `
${filler}
Not 1
Räkenskapsåret som avslutades den 31 december 2024
Belopp i msek
`;
    const r = extractFields(text, 'Example AB', null);
    expect(r.data.fiscal_year).toBe(2024);
  });

  it('reads leading-year cover title in the first pages', () => {
    const text = `
2024 Annual and sustainability report
Example AB (publ)
`;
    const r = extractFields(text, 'Example AB', null);
    expect(r.data.fiscal_year).toBe(2024);
  });
});
