import { extractFields } from '../src/extraction/field-extractor';

// ── Alternate-label ceiling ──────────────────────────────────────────────────
//
// When the primary labeled extraction returns a low value and the alternate-label
// scan finds a candidate that is >100× the primary value, the revision should be
// rejected.  The pattern arises when revenue is inflated (KSEK misread as MSEK)
// causing the plausibility gate to fire, then the scan picks up a large
// headcount from a different table row (e.g. platform connections, partner FTE).
//
// Primary label: "Number of employees 985"
// Alternate row: "Average number of employees 439 453" (space = thousands separator,
//   parsed as 439 453 → 439453 by parseNumber).  Revenue inflated to 313 855 MSEK.
// 439 453 > 985 × 100 = 98 500 → ceiling must reject the revision.
const ALT_LABEL_CEILING_TEXT = `
Annual report 2025

Total revenue         313 855
Operating income       44 588

Number of employees       985
Average number of employees 439 453

Anna Andersson
CEO
`;

describe('employee extraction — alternate-label revision ceiling', () => {
  it('rejects alternate-label candidate when >100× labeled value', () => {
    const r = extractFields(ALT_LABEL_CEILING_TEXT, 'Gamingco AB', 2025);
    expect(r.data.employees).not.toBe(439_453);
    expect(
      r.notes.some((n) => /alternate-label employee.*rejected/i.test(n)),
    ).toBe(true);
  });

  it('still applies alternate-label revision when candidate is within 100× window', () => {
    // Primary: 150, alternate labeled row: 3 000 (20×) — should be accepted
    const text = `
Annual report 2025
Net sales 50000
Operating profit 5000
Number of employees 150
Average number of employees 3000
CEO: Per Persson
`;
    const r = extractFields(text, 'Midco AB', 2025);
    // 3 000 ≤ 150 × 100 = 15 000 → revision allowed; rejection note absent
    expect(r.notes.some((n) => /alternate-label employee.*rejected/i.test(n))).toBe(false);
  });
});

// ── SUSPECT_LOW narrative ceiling ────────────────────────────────────────────
//
// When SUSPECT_LOW fires and the narrative fallback returns a value that is
// >100× the current labeled count, the revision must be rejected.  The pattern
// occurs in shipping / asset-heavy reports where "number of employees 214255"
// matches the narrative regex but "214255" is actually a capacity metric (CEU).
//
// Numbers are written without thousand-separators to match \d{2,6} regex group.
// Primary labeled: 469 employees; narrative match: 214255 (456×) → reject.
const SUSPECT_LOW_NARRATIVE_CEILING_TEXT = `
Annual report 2025

Net revenues (USD m)    1446
Operating profit (USD m)   627

Number of employees       469

Fleet capacity 214255 CEU
The number of employees was 214255 as of year-end.

Anna Svensson
Chief Executive Officer
`;

describe('employee extraction — SUSPECT_LOW narrative ceiling', () => {
  it('rejects narrative candidate when >100× labeled value', () => {
    const r = extractFields(
      SUSPECT_LOW_NARRATIVE_CEILING_TEXT,
      'Shippingco ASA',
      2025,
    );
    expect(r.data.employees).not.toBe(214_255);
    expect(
      r.notes.some((n) => /SUSPECT_LOW narrative.*rejected/i.test(n)),
    ).toBe(true);
  });

  it('still applies SUSPECT_LOW narrative when candidate is within 100× window', () => {
    // Labeled: 300, narrative: 12000 (40×) — should be accepted
    const text = `
Annual report 2025
Net sales 80000
Operating profit 8000
Number of employees 300
On average, the group had 12000 employees during the year.
CEO: Stina Stinson
`;
    const r = extractFields(text, 'Bigco AB', 2025);
    expect(r.data.employees).toBe(12_000);
    expect(
      r.notes.some((n) => /Employee count revised from \d+ to 12000 via narrative/i.test(n)),
    ).toBe(true);
  });
});
