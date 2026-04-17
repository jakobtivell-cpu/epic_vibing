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
Summa intäkter         70 234  68 100
Räntenetto             40 000  39 000
Rörelseresultat        32 100  31 200
Övrigt                 100     100
Rad fem                1       1
Medelantalet anställda 12 450  12 100
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
    expect(r.data.employees).toBe(12_100);
  });

  it('uses profit before impairments as bank EBIT proxy', () => {
    const text = [
      'Consolidated income statement',
      'Total operating income  50 000',
      'Profit before impairments  11 500',
    ].join('\n');
    const r = extractFields(text, 'BankProxyA', 2025, 'bank');
    expect(r.data.ebit_msek).toBe(11_500);
  });

  it('uses result before tax as last-resort bank proxy and adds note', () => {
    const text = [
      'Consolidated income statement',
      'Total operating income  50 000',
      'Result before tax  9 900',
    ].join('\n');
    const r = extractFields(text, 'BankProxyB', 2025, 'bank');
    expect(r.data.ebit_msek).toBe(9_900);
    expect(
      r.notes.some((n) =>
        n.includes('EBIT estimated from profit before tax — bank reporting, no pure EBIT available'),
      ),
    ).toBe(true);
  });

  it('accepts IFRS-style bank terms net commission income and profit before credit losses', () => {
    const text = [
      'Consolidated income statement',
      'Net commission income  18 200',
      'Profit before credit losses  7 600',
    ].join('\n');
    const r = extractFields(text, 'BankIFRSTerms', 2025, 'bank');
    expect(r.data.revenue_msek).toBe(18_200);
    expect(r.data.ebit_msek).toBe(7_600);
  });
});
