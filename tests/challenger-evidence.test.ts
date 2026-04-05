import { estimatePageFromSnippet, verifyQuoteInDocument, buildLlmContextWindows } from '../src/challenger/evidence';

describe('challenger evidence helpers', () => {
  it('estimatePageFromSnippet maps position to page band', () => {
    const text = 'a'.repeat(1000) + 'TARGET_SNIPPET_UNIQUE' + 'b'.repeat(9000);
    const page = estimatePageFromSnippet(text, 'TARGET_SNIPPET_UNIQUE', 10);
    expect(page).toBeGreaterThanOrEqual(1);
    expect(page).toBeLessThanOrEqual(10);
  });

  it('verifyQuoteInDocument accepts collapsed match', () => {
    const doc = 'The  net   sales were  100  in  2025.';
    expect(verifyQuoteInDocument('net sales were 100', doc)).toBe(true);
  });

  it('buildLlmContextWindows includes head section', () => {
    const w = buildLlmContextWindows('hello\nresultaträkning\nfoo', 50_000);
    expect(w).toContain('[SECTION:HEAD]');
    expect(w).toContain('resultaträkning');
  });
});
