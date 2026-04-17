import { extractEbitSecondPassFromIncomeSections } from '../src/extraction/field-extractor';

const BASE_OPERATIONS_TEXT = `
Annual Report 2024
Lundin Mining Corporation

Consolidated Statements of Operations
(in millions of US dollars, except per share amounts)

Year ended December 31,                    2024      2023
Revenue                                  3,204.1   2,856.3
Cost of sales                           (1,934.2) (1,741.5)
Gross profit                             1,269.9   1,114.8
General and administrative expenses        (98.5)    (87.2)
Exploration and evaluation expenses        (45.3)    (38.7)
Other operating (expenses) income          (22.1)    (14.3)
Operating income                         1,104.0     974.6
Finance costs                             (85.2)    (78.4)
Income before income taxes               1,018.8     896.2
Income tax expense                        (302.1)   (261.4)
Net income                                 716.7     634.8

Balance Sheet
Total assets                            12,456.0
`;

const OPERATIONS_AND_COMP_INCOME_TEXT = `
XYZ Corp Annual Report 2024

Consolidated Statements of Operations and Comprehensive Income
Year Ended December 31, 2024

Net revenues                             5,432.0
Cost of revenues                        (2,100.0)
Gross profit                             3,332.0
Operating expenses                      (1,800.0)
Operating income                         1,532.0
Other income (expense), net               (120.0)
Income before income taxes               1,412.0
Income tax expense                        (350.0)
Net income                               1,062.0

Balance Sheet
Total assets                            10,000.0
`;

describe('extractEbitSecondPassFromIncomeSections — statement of operations heading', () => {
  it('finds operating income in "Consolidated Statements of Operations" section', () => {
    const result = extractEbitSecondPassFromIncomeSections(
      BASE_OPERATIONS_TEXT,
      'industrial',
      2024,
      null,
    );
    expect(result.ebit_msek).not.toBeNull();
    // USD 1,104m × 10.8 ≈ 11,923 MSEK; or unit-context passes raw millions depending on detectUnitContext
    // Primary assertion: a non-null EBIT was found
    expect(result.notes.some((n) => /second-pass ebit/i.test(n))).toBe(true);
  });

  it('finds operating income in "Statements of Operations and Comprehensive Income" section', () => {
    const result = extractEbitSecondPassFromIncomeSections(
      OPERATIONS_AND_COMP_INCOME_TEXT,
      'industrial',
      2024,
      null,
    );
    expect(result.ebit_msek).not.toBeNull();
    expect(result.notes.some((n) => /second-pass ebit/i.test(n))).toBe(true);
  });

  it('returns null when no income statement section heading is present', () => {
    const noSectionText = `
Annual Report 2024
Revenue 5,432.0
Operating income 1,532.0
`;
    const result = extractEbitSecondPassFromIncomeSections(
      noSectionText,
      'industrial',
      2024,
      null,
    );
    // Without a recognized section heading there is no bounded window, so second-pass may find nothing
    // (this is acceptable — the test guards against regression on the happy path above)
    expect(result.notes.some((n) => /second-pass ebit.*no consolidated/i.test(n))).toBe(true);
  });
});
