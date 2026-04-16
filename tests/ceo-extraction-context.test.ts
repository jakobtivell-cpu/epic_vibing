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

  it('rejects role-only title phrases as CEO name candidates', () => {
    const text = `
Annual report 2025
Managing Partner
Chief Executive Officer
Internal Audit
VD
`;
    const r = extractFields(text, 'RoleOnlyCo', 2025);
    expect(r.data.ceo).toBeNull();
  });

  it('rejects adjacent report headings captured as CEO (e.g. "Changing World" on the line after the CEO title)', () => {
    const text = `
Annual report 2025
Chief Executive Officer
Changing World
`;
    const r = extractFields(text, 'PharmaCo PLC', 2025);
    expect(r.data.ceo).toBeNull();
  });

  it('rejects HR org title captured as CEO (line after CEO heading)', () => {
    const text = `
Annual report 2025
President and CEO
Chief Human Resources
`;
    const r = extractFields(text, 'Example AB', 2025);
    expect(r.data.ceo).toBeNull();
  });

  it('rejects CEO line that only echoes the legal company trading name', () => {
    const text = `
Annual report 2025
Höegh Autoliners
President and CEO
`;
    const r = extractFields(text, 'Höegh Autoliners ASA', 2025);
    expect(r.data.ceo).toBeNull();
  });
});

describe('CEO extraction — retry after boilerplate discard', () => {
  it('finds real person name after discarding a boilerplate candidate on first pass', () => {
    // Pattern: boilerplate echo appears near first CEO label; real name near second
    const text = `
Annual report 2025

Message from the CEO
Changing World

Dear shareholders,

Management team
Anna Andersson
President and CEO
`;
    const r = extractFields(text, 'PharmaCo PLC', 2025);
    expect(r.data.ceo).toBe('Anna Andersson');
  });

  it('finds real person name after discarding company-name echo', () => {
    const text = `
Annual report 2025

CEO letter
Höegh Autoliners
President and CEO

Group management
Bent Martini
President & CEO
`;
    const r = extractFields(text, 'Höegh Autoliners ASA', 2025);
    expect(r.data.ceo).toBe('Bent Martini');
  });

  it('finds real person name after discarding HR org title', () => {
    const text = `
Annual report 2025

President and CEO
Chief Human Resources

Leadership
Magnus Ahlqvist
Group President and CEO
`;
    const r = extractFields(text, 'Securitas AB (publ)', 2025);
    expect(r.data.ceo).toBe('Magnus Ahlqvist');
  });

  it('still returns null when all retries exhaust candidates', () => {
    const text = `
Annual report 2025
Boilerplate Company
President and CEO
Exchange Act Rule
Chief Executive Officer
Chief Human Resources
VD
`;
    const r = extractFields(text, 'Boilerplate Company', 2025);
    expect(r.data.ceo).toBeNull();
  });
});
