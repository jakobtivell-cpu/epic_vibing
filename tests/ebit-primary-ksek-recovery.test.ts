import { extractFields } from '../src/extraction/field-extractor';

describe('Primary EBIT ÷1000 when candidate dwarfs revenue (KSEK-as-MSEK)', () => {
  it('still finds and recovers when revenue is modest (search ceiling includes KSEK slop)', () => {
    const text = `
Annual report 2025
Amounts in SEK m
Koncernens resultaträkning
Nettoomsättning 15 617
Råvaror 100
Bruttoresultat 500
Övrigt 0
Rörelseresultat 6 766 362
`;
    const r = extractFields(text, 'Shipping ASA', 2025);
    expect(r.data.revenue_msek).toBe(15_617);
    expect(r.data.ebit_msek).toBe(6766);
  });

  it('recovers operating profit scaled down to sit below revenue', () => {
    const text = `
Annual report 2025
Amounts in SEK m
Koncernens resultaträkning
Råvaror 100
Bruttoresultat 500
Övrigt 0
Nettoomsättning 150 000
Rörelseresultat 6 766 362
`;
    const r = extractFields(text, 'Shipping ASA', 2025);
    expect(r.data.revenue_msek).toBe(150_000);
    expect(r.data.ebit_msek).toBe(6766);
    expect(
      r.notes.some((n) => /Primary EBIT ÷1000 recovery/i.test(n)),
    ).toBe(true);
  });
});
