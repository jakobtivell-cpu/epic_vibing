import {
  extractFields,
  shouldDiscardOrphanEbitVersusHeadcount,
} from '../src/extraction/field-extractor';

describe('shouldDiscardOrphanEbitVersusHeadcount', () => {
  it('flags tiny EBIT vs Large Cap headcount when revenue is missing', () => {
    expect(shouldDiscardOrphanEbitVersusHeadcount(null, 19, 8496, 'industrial')).toBe(true);
    expect(shouldDiscardOrphanEbitVersusHeadcount(null, 5, 11_000, 'industrial')).toBe(true);
    expect(shouldDiscardOrphanEbitVersusHeadcount(null, 3, 400, 'industrial')).toBe(true);
  });

  it('keeps EBIT when revenue exists or magnitude is plausible without revenue', () => {
    expect(shouldDiscardOrphanEbitVersusHeadcount(120_000, 19, 8496, 'industrial')).toBe(false);
    expect(shouldDiscardOrphanEbitVersusHeadcount(null, 567, 2506, 'industrial')).toBe(false);
    expect(shouldDiscardOrphanEbitVersusHeadcount(null, 19, 120, 'industrial')).toBe(false);
  });

  it('does not apply to investment companies', () => {
    expect(shouldDiscardOrphanEbitVersusHeadcount(null, 10, 5000, 'investment_company')).toBe(
      false,
    );
  });
});

describe('extractFields — orphan EBIT integration', () => {
  it('does not discard EBIT when revenue was extracted', () => {
    const text = `
Annual report 2025
Amounts in SEK m
Consolidated income statement
Net sales 120 000
Average number of employees 8 496
Operating profit 19 000
`;
    const r = extractFields(text, 'HygieneCo AB', 2025);
    expect(r.data.revenue_msek).toBe(120_000);
    expect(r.data.ebit_msek).toBe(19_000);
  });
});
