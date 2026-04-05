import * as fs from 'fs';
import * as path from 'path';

/**
 * Discovery contract: every curated irPage in data/ticker.json must be a usable HTTPS URL
 * on a real multi-label hostname (not localhost or opaque paths).
 */
describe('ticker.json irPage URLs', () => {
  const tickerPath = path.join(__dirname, '..', 'data', 'ticker.json');

  it('every object entry with irPage has https URL and plausible hostname', () => {
    const raw = fs.readFileSync(tickerPath, 'utf8');
    const data = JSON.parse(raw) as Record<string, unknown>;

    const failures: string[] = [];

    for (const [sym, val] of Object.entries(data)) {
      if (!val || typeof val !== 'object') continue;
      const ir = (val as { irPage?: unknown }).irPage;
      if (typeof ir !== 'string' || !ir.trim()) continue;

      try {
        const u = new URL(ir.trim());
        if (u.protocol !== 'https:') {
          failures.push(`${sym}: expected https, got ${u.protocol}`);
          continue;
        }
        const host = u.hostname.toLowerCase();
        if (!host || !host.includes('.')) {
          failures.push(`${sym}: hostname missing or single-label: ${host}`);
          continue;
        }
        if (!/^[a-z0-9.-]+$/i.test(host)) {
          failures.push(`${sym}: hostname has unexpected chars: ${host}`);
        }
      } catch {
        failures.push(`${sym}: invalid URL ${JSON.stringify(ir)}`);
      }
    }

    expect(failures).toEqual([]);
  });
});
