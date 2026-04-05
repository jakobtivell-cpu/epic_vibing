import {
  classifyRevenueMapping,
  classifyEbitMapping,
  formatMappingNotes,
} from '../src/extraction/schema-mapping';

describe('schema-mapping', () => {
  it('marks bank revenue as mapped with explanation', () => {
    const m = classifyRevenueMapping('bank', 'Total operating income');
    expect(m.basis).toBe('mapped');
    expect(m.assignmentField).toBe('revenue_msek');
    expect(m.explanation.toLowerCase()).toContain('bank');
  });

  it('marks industrial revenue exact for net sales', () => {
    const m = classifyRevenueMapping('industrial', 'Net sales');
    expect(m.basis).toBe('exact');
  });

  it('formats mapping notes for pipeline', () => {
    const lines = formatMappingNotes([
      classifyRevenueMapping('bank', 'räntenetto'),
      classifyEbitMapping('bank', 'Operating profit'),
    ]);
    expect(lines.some((l) => l.startsWith('SCHEMA_MAP[revenue_msek]'))).toBe(true);
    expect(lines.some((l) => l.startsWith('SCHEMA_MAP[ebit_msek]'))).toBe(true);
  });
});
