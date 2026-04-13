import { shouldUseNarrowEbitLlmRepair } from '../src/challenger/llm-extract';

describe('shouldUseNarrowEbitLlmRepair', () => {
  it('is true when EBIT null, revenue present, and notes show discard', () => {
    expect(
      shouldUseNarrowEbitLlmRepair(
        { revenue_msek: 1000, ebit_msek: null },
        ['Bank: operating result (5000) exceeds revenue-equivalent (1000) — discarding EBIT for assignment safety'],
      ),
    ).toBe(true);
  });

  it('is false when EBIT is already set', () => {
    expect(
      shouldUseNarrowEbitLlmRepair(
        { revenue_msek: 1000, ebit_msek: 100 },
        ['discarding ebit'],
      ),
    ).toBe(false);
  });

  it('is false without discard hints in notes', () => {
    expect(
      shouldUseNarrowEbitLlmRepair({ revenue_msek: 1000, ebit_msek: null }, ['EBIT not extracted']),
    ).toBe(false);
  });
});
