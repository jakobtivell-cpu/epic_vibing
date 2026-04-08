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

  it('does not fuse compact multi-column sales values into a giant number', () => {
    const text = [
      'Koncernens resultaträkning',
      '2025    2024',
      'Sales  215 016 215 240',
      'Operating income  34 000 33 000',
      'Balansräkning',
    ].join('\n');

    const r = extractFields(text, 'AssaLike', 2025);
    expect(r.data.revenue_msek).toBe(215_016);
    expect(r.data.revenue_msek).not.toBe(2_150_162_152_409);
  });

  it('reconstructs compact columns even when an extra trailing group appears', () => {
    const text = [
      'Koncernens resultaträkning',
      '2025    2024',
      'Sales  215 016 215 240 9000',
      'Balansräkning',
    ].join('\n');

    const r = extractFields(text, 'AssaLikeTrailing', 2025);
    expect(r.data.revenue_msek).toBe(215_016);
  });

  it('handles glued thousand-pair columns without separators', () => {
    const text = [
      'Koncernens resultaträkning',
      '2025    2024',
      'Omsättning, MSEK150 162152 409+1%',
      'Balansräkning',
    ].join('\n');

    const r = extractFields(text, 'AssaGlued', 2025);
    expect(r.data.revenue_msek).toBe(150_162);
  });

  it('discards year-like employee values from misread fiscal-year columns', () => {
    const text = [
      'Koncernens resultaträkning',
      '2025    2024',
      'Net sales  120 000 115 000',
      'Employees  2025  2024',
    ].join('\n');

    const r = extractFields(text, 'EmpYearLike', 2025);
    expect(r.data.employees).toBeNull();
  });
});
