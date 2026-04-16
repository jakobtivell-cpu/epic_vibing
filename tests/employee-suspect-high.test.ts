import { extractFields } from '../src/extraction/field-extractor';

// Real estate company: rental income ~5 BSEK but the employee table column
// contains a multi-year concat value "99 284" (two adjacent year columns 99
// and 284 run together by the OCR renderer, giving 99284).
// Since 99284 < 200 000, the existing OCR guard (> 200 000) does not fire.
// SUSPECT_HIGH should fire (revenue 5000 / 99284 ≈ 0.050 MSEK/emp) and
// prefer the narrative sentence "The group had 200 employees".
const SUSPECT_HIGH_TEXT = `
Annual report 2025

Net sales                5 000
Operating profit           800

Number of employees   99 284   98 112

The group had 200 employees at year-end.

Anna Andersson
President and CEO
`;

describe('employee extraction — SUSPECT_HIGH', () => {
  it('revises sub-200k but still implausibly high count downward via narrative', () => {
    const r = extractFields(SUSPECT_HIGH_TEXT, 'Propertyco AB', 2025);
    // Narrative (200) should win over the high table value (~99k range)
    expect(r.data.employees).toBe(200);
    expect(r.notes.some((n) => /SUSPECT_HIGH/i.test(n))).toBe(true);
    // Note format: "Employee count revised from N to 200 via narrative (...)"
    expect(
      r.notes.some((n) => /Employee count revised from \d+ to 200 via narrative/i.test(n)),
    ).toBe(true);
  });

  it('does NOT trigger SUSPECT_HIGH when revenue-per-employee ratio is plausible', () => {
    const text = `
Annual report 2025
Net sales 26 137
Number of employees 10 000
Lars Eriksson
President and CEO
`;
    const r = extractFields(text, 'Normal AB', 2025);
    expect(r.notes.some((n) => /SUSPECT_HIGH/i.test(n))).toBe(false);
    expect(r.data.employees).toBe(10_000);
  });

  it('does NOT trigger SUSPECT_HIGH for banks regardless of ratio', () => {
    // Banks have tiny "revenue" proxies — always exempt.
    const text = `
Annual report 2025
Total operating income 70 234
Average number of employees 50 000
Anna Andersson
President and CEO
`;
    const r = extractFields(text, 'Swedish Bank AB', 2025, 'bank');
    expect(r.notes.some((n) => /SUSPECT_HIGH/i.test(n))).toBe(false);
  });
});
