import { classifyFailureClass } from '../src/output/writer';
import { buildTimeoutResult } from '../src/pipeline';
import type { CompanyProfile } from '../src/types';

describe('timeout result + failure class', () => {
  it('classifies timeout status as failureClass timeout', () => {
    const profile: CompanyProfile = { name: 'TestCo AB', ticker: 'TEST.ST' };
    const r = buildTimeoutResult(profile, 42_000);
    expect(r.status).toBe('timeout');
    expect(r.confidence).toBe(0);
    expect(r.extractionNotes[0]).toBe('Pipeline timed out after 42000ms');
    expect(classifyFailureClass(r)).toBe('timeout');
  });
});
