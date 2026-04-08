import { extractFields } from '../src/extraction/field-extractor';

describe('CEO extraction — AGM / nomination context', () => {
  it('ignores CEO label lines inside valberedning / proposal blocks', () => {
    const text = `
Årsstämma 2025
Valberedningens förslag
Erik Example
Chief Executive Officer
`;
    const r = extractFields(text, 'Test AB', 2025);
    expect(r.data.ceo).toBeNull();
  });

  it('still finds CEO in a normal letter block', () => {
    const text = `
Annual report 2025
Maria Samplesson
President and CEO
`;
    const r = extractFields(text, 'Test AB', 2025);
    expect(r.data.ceo).toBe('Maria Samplesson');
  });

  it('rejects ESEF phrase as CEO name', () => {
    const text = `
Annual report 2025
European Single Electronic Format
Chief Executive Officer
`;
    const r = extractFields(text, 'AB Industrivärden (publ)', 2025, 'investment_company');
    expect(r.data.ceo).toBeNull();
  });
});
