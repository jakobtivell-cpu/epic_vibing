import { buildEntityProfile } from '../src/entity/entity-profile';
import { verifyEntityInPdf } from '../src/validation/post-download-checks';

describe('verifyEntityInPdf', () => {
  it('accepts Saab branding for legal entity Saab AB (publ)', () => {
    const entity = buildEntityProfile({
      name: 'Saab',
      legalName: 'Saab AB (publ)',
      ticker: 'SAAB-B.ST',
    });
    const text =
      'Saab AB (publ)\nAnnual report 2025\nConsolidated income statement\nNet sales 95,000 MSEK';
    const r = verifyEntityInPdf(text, entity);
    expect(r.passed).toBe(true);
    expect(r.matchedTerm).toBeTruthy();
  });

  it('does not pass Skandinaviska Enskilda Banken when the PDF is clearly Groupe SEB', () => {
    const entity = buildEntityProfile({
      name: 'SEB',
      legalName: 'Skandinaviska Enskilda Banken AB (publ)',
      ticker: 'SEB-A.ST',
    });
    const text =
      'Groupe SEB\nUniversal registration document 2024\nConsumer appliances and cookware\nRevenue EUR 7.9 billion';
    const r = verifyEntityInPdf(text, entity);
    expect(r.passed).toBe(false);
  });

  it('passes when Swedish bank legal name appears in PDF header', () => {
    const entity = buildEntityProfile({
      name: 'SEB',
      legalName: 'Skandinaviska Enskilda Banken AB (publ)',
      ticker: 'SEB-A.ST',
    });
    const text =
      'Skandinaviska Enskilda Banken AB (publ)\nAnnual Report 2025\nOperating income …';
    const r = verifyEntityInPdf(text, entity);
    expect(r.passed).toBe(true);
  });
});
