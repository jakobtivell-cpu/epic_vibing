import { extractFields } from '../src/extraction/field-extractor';

describe('unit normalization edge cases', () => {
  it('avoids committing values when mixed-unit row formatting is ambiguous', () => {
    const text = [
      'Key figures (MSEK)',
      'Consolidated income statement',
      'Net sales (kSEK) 1 200 000',
      'Operating income (kSEK) 120 000',
    ].join('\n');

    const r = extractFields(text, 'MixedUnitCo', 2025);
    expect(r.data.revenue_msek).toBeNull();
    expect(r.data.ebit_msek).toBeNull();
  });

  it('converts EUR-million statements consistently to MSEK', () => {
    const text = [
      'Consolidated income statement',
      'Amounts in million euros',
      'Revenue 120',
      'Operating profit 3.5',
      'Average number of employees 1500',
    ].join('\n');

    const r = extractFields(text, 'EuroDenomCo', 2025);
    expect(r.data.revenue_msek).toBe(1350);
    expect(r.data.ebit_msek).toBeGreaterThanOrEqual(39);
    expect(r.data.ebit_msek).toBeLessThanOrEqual(40);
  });

  it('drops fused year-number artifacts before numeric acceptance', () => {
    const text = [
      'Consolidated income statement',
      'Net sales 200 000',
      'Operating income 20252024',
    ].join('\n');

    const r = extractFields(text, 'FusedArtifactCo', 2025);
    expect(r.data.revenue_msek).toBe(200000);
    expect(r.data.ebit_msek).toBeNull();
  });
});
