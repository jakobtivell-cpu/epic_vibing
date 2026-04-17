import { extractFields } from '../src/extraction/field-extractor';
import { extractEbitSecondPassFromIncomeSections } from '../src/extraction/field-extractor';

// Minimal PDF text helper — avoids network calls
function makeText(body: string): string {
  return `
Annual Report 2024

Resultaträkning
Net sales            2,600
Operating result       210
Profit before tax      195

Balance Sheet
Total assets         5,000

${body}
`;
}

describe('Swedish narrative employee extraction', () => {
  it('finds "N medarbetare" (number-before-label)', () => {
    const text = makeText(
      'Under 2024 hade Camurus 287 medarbetare i koncernen.',
    );
    const result = extractFields(text, 'Camurus AB (publ)', 2024, 'unspecified');
    expect(result.data.employees).toBe(287);
    expect(result.notes.some((n) => /narrative|medarbetare/i.test(n))).toBe(true);
  });

  it('finds "N anställda" (bare Swedish employees label)', () => {
    const text = makeText(
      'Wallenstam AB hade vid årets slut 198 anställda.',
    );
    const result = extractFields(text, 'Wallenstam AB (publ)', 2024, 'real_estate');
    expect(result.data.employees).toBe(198);
    expect(result.notes.some((n) => /narrative|anst[äa]llda/i.test(n))).toBe(true);
  });

  it('finds "hade N anställda" pattern', () => {
    const text = makeText(
      'Koncernen hade 1 254 anställda vid utgången av räkenskapsåret.',
    );
    const result = extractFields(text, 'TestCo AB', 2024, null);
    expect(result.data.employees).toBe(1254);
  });

  it('finds "employs N people" (English narrative)', () => {
    const text = makeText(
      'As of December 31, 2024, the company employs 412 people across 15 countries.',
    );
    const result = extractFields(text, 'TestCo', 2024, null);
    expect(result.data.employees).toBe(412);
  });
});

describe('Swedish IFRS income statement section detection', () => {
  it('finds EBIT in rapport-över-totalresultat section', () => {
    const text = `
Annual Report 2024

Rapport över totalresultat
Nettoomsättning          12,300
Rörelsekostnader         -9,800
Rörelseresultat           2,500
Finansiella poster          -150
Resultat före skatt       2,350

Balansräkning
Summa tillgångar         50,000
`;
    const result = extractEbitSecondPassFromIncomeSections(text, 'industrial', 2025, 12300);
    expect(result.ebit_msek).not.toBeNull();
    expect(result.notes.some((n) => /second-pass ebit/i.test(n))).toBe(true);
  });
});
