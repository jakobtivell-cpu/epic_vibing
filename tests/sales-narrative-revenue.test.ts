import { extractFields } from '../src/extraction/field-extractor';

describe('Revenue from Sales / SEK billion narrative', () => {
  it('parses Sales, SEK billion with value on the next line (infographic style)', () => {
    const text = `
Key figures
Sales, SEK billion
79
Operating margin
`;
    const r = extractFields(text, 'Saab', 2025);
    expect(r.data.revenue_msek).toBe(79_000);
    expect(r.provenance.revenue?.matchedLabel).toMatch(/Sales, SEK billion/i);
  });

  it('parses Sales, SEK billion with value on the same line', () => {
    const text = 'Highlights\nSales, SEK billion  79\nOther';
    const r = extractFields(text, 'Test', 2025);
    expect(r.data.revenue_msek).toBe(79_000);
  });

  it('fills revenue after fused-year discard using Sales narrative', () => {
    const text = `
Resultaträkning
Sales 20252024000
Sales, SEK billion
79
`;
    const r = extractFields(text, 'Saab', 2025);
    expect(r.data.revenue_msek).toBe(79_000);
    expect(r.notes.some((n) => n.includes('fused year'))).toBe(true);
  });

});
