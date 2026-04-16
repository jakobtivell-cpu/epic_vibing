import { urlScore } from '../src/discovery/report-ranker';

describe('urlScore — M&A / acquisition deck paths', () => {
  it('scores Sandvik-style acqusition presentation well below a plain annual-report PDF', () => {
    const deck = urlScore(
      'https://www.home.sandvik.com/en/media/documents/acqusition-presentations/presentation-cambrio.pdf',
    );
    const annual = urlScore('https://www.home.sandvik.com/en/media/annual-report-2025-en.pdf');
    expect(deck).toBeLessThan(annual - 20);
  });
});
