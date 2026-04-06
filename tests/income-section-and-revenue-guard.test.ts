import { extractFields } from '../src/extraction/field-extractor';

describe('income statement section selection', () => {
  it('prefers consolidated income statement over parent-company (moderbolag) section', () => {
    const text = [
      'Moderbolagets resultaträkning',
      'Note',
      'Net sales',
      '888888',
      'Operating income',
      '1000',
      'Koncernens resultaträkning',
      'Note',
      'Net sales',
      '120000',
      'Operating income',
      '5000',
      'Balansräkning',
      'assets',
    ].join('\n');

    const r = extractFields(text, 'TestCo', 2025);
    expect(r.data.revenue_msek).toBe(120000);
  });
});

describe('revenue MSEK unit guard', () => {
  it('scales down industrial revenue above 3,000,000 MSEK (tkr/KSEK misread as MSEK)', () => {
    const text = [
      'Koncernens resultaträkning',
      'Net sales',
      '5000000',
      'Operating income',
      '200000',
      'Balansräkning',
    ].join('\n');

    const r = extractFields(text, 'EssityLike', 2025);
    expect(r.data.revenue_msek).toBe(5000);
    expect(r.notes.some((n) => n.includes('unit guard'))).toBe(true);
  });
});
