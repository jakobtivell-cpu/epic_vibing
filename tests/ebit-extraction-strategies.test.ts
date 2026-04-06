import { extractFields } from '../src/extraction/field-extractor';

describe('EBIT extraction strategies', () => {
  it('Priority 1: extracts EBIT via Resultat före finansnetto', () => {
    const text = [
      'Koncernens resultaträkning',
      '2025    2024',
      'Net sales    88 000  85 000',
      'Resultat före finansnetto  9 200  8 100',
      'Balansräkning',
    ].join('\n');
    const r = extractFields(text, 'P1Co', 2025);
    expect(r.data.ebit_msek).toBe(9200);
  });

  it('Priority 2: uses Adjusted EBIT and adds adjusted-variant note', () => {
    const text = [
      'Koncernens resultaträkning',
      'Net sales    50 000',
      'EBITDA       8 000',
      'Adjusted EBIT  6 200',
      'Balansräkning',
    ].join('\n');
    const r = extractFields(text, 'AdjCo', 2025);
    expect(r.data.ebit_msek).toBe(6200);
    expect(
      r.notes.some((n) => n.includes('EBIT sourced from adjusted variant — verify against reported figure')),
    ).toBe(true);
  });

  it('Priority 3: derives EBIT from operating margin × table revenue', () => {
    const text = [
      'Koncernens resultaträkning',
      'Net sales   100000',
      'Balansräkning',
      'Nyckeltal',
      'Operating margin  12.5%',
    ].join('\n');
    const r = extractFields(text, 'MarginCo', 2025);
    expect(r.data.revenue_msek).toBe(100_000);
    expect(r.data.ebit_msek).toBe(12_500);
    expect(r.notes.some((n) => n.includes('EBIT derived from operating margin × revenue — verify'))).toBe(
      true,
    );
  });

  it('Priority 3: skips margin derivation when revenue is narrative-only', () => {
    const text = [
      'Sales, SEK billion',
      '79',
      'Operating margin  15%',
    ].join('\n');
    const r = extractFields(text, 'NarrRevCo', 2025);
    expect(r.data.revenue_msek).toBe(79_000);
    expect(r.data.ebit_msek).toBeNull();
  });

  it('Priority 4: derives EBIT from EBITA minus amortization of intangibles', () => {
    const text = [
      'Koncernens resultaträkning',
      'Net sales   40000',
      'Balansräkning',
      'Note — adjusted measures',
      'EBITA   7200',
      'Amortization of intangible assets  700',
    ].join('\n');
    const r = extractFields(text, 'EbitaCo', 2025);
    expect(r.data.ebit_msek).toBe(6500);
    expect(r.notes.some((n) => n.includes('EBIT derived from EBITA minus amortization'))).toBe(true);
  });

  it('Priority 5: sums segment rörelseresultat före finansiella poster', () => {
    const text = [
      'Koncernens resultaträkning',
      'Net sales   100000',
      'Balansräkning',
      'Segmentöversikt',
      'Rörelseresultat före finansiella poster',
      'Division A   4000',
      'Division B   6000',
    ].join('\n');
    const r = extractFields(text, 'SegCo', 2025);
    expect(r.data.ebit_msek).toBe(10_000);
    expect(
      r.notes.some((n) => n.includes('EBIT derived from sum of segment results — verify consolidation')),
    ).toBe(true);
  });
});
