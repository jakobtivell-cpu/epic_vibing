import { detectUnitContext } from '../src/extraction/field-extractor';

describe('detectUnitContext — EUR footnote vs SEK income statement', () => {
  it('prefers explicit SEK millions when MEUR appears only in early footnote-style text', () => {
    const text = `
Annual report 2024
Notes to bondholders: issuance of 500 MEUR notes.
Table of contents
${'padding\n'.repeat(200)}
Consolidated income statement
Amounts in SEK m
Net sales 15 400
`;
    expect(detectUnitContext(text)).toBe('msek');
  });

  it('still keeps EUR when it is the first explicit reporting currency without body SEK m', () => {
    const text = `
Annual report 2024
Amounts in million euros
Net sales 1,200
`;
    expect(detectUnitContext(text)).toBe('eur_m');
  });
});
