import { extractFields, resolveCompanyTypeForExtraction } from '../src/extraction/field-extractor';

const EN_BANK_INCOME = `
Annual report 2025

Amounts in SEK m

Consolidated income statement

2025    2024
Total operating income  70 234  68 100
Net interest income     40 012  39 200
Operating profit        32 100  31 200
Other costs             1 000   1 000
Minor line              2       2

Average number of employees  16 500  16 200

President and CEO
Anna Andersson
`;

const SV_BANK_INCOME = `
Belopp i MSEK

Koncernens resultaträkning

2025    2024
Summa rörelseintäkter  70 234  68 100
Räntenetto             40 000  39 000
Rörelseresultat        32 100  31 200
Övrigt                 100     100
Rad fem                1       1
`;

describe('bank field extraction', () => {
  it('forces bank mode from reporting hint on sparse text', () => {
    expect(resolveCompanyTypeForExtraction('no bank words here', 'bank')).toBe('bank');
  });

  it('extracts revenue and EBIT from English bank income statement with hint', () => {
    const r = extractFields(EN_BANK_INCOME, 'Skandinaviska Enskilda Banken AB', 2025, 'bank');
    expect(r.detectedCompanyType).toBe('bank');
    expect(r.data.revenue_msek).toBe(70_234);
    expect(r.data.ebit_msek).toBe(32_100);
    expect(
      r.notes.some((n) => /Bank — 'total operating income' mapped to revenue_msek/.test(n)),
    ).toBe(true);
    expect(r.notes.some((n) => /Bank — 'operating profit' mapped to ebit_msek/.test(n))).toBe(true);
  });

  it('extracts Swedish bank labels with hint', () => {
    const r = extractFields(SV_BANK_INCOME, 'SEB', 2025, 'bank');
    expect(r.data.revenue_msek).toBe(70_234);
    expect(r.data.ebit_msek).toBe(32_100);
  });
});
