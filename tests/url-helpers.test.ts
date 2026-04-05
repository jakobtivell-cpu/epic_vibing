import { resolveUrl } from '../src/utils/url-helpers';

describe('resolveUrl', () => {
  it('removes encoded-quote path segments and collapses doubled slashes (Alfa Laval–style hrefs)', () => {
    const base = 'https://www.alfalaval.com/';
    const href = '/%22/investors//%22';
    const out = resolveUrl(base, href);
    expect(out).toBe('https://www.alfalaval.com/investors');
  });

  it('strips a wrapped quoted relative href before resolving', () => {
    const base = 'https://www.example.com/';
    expect(resolveUrl(base, '"/about//team/"')).toBe('https://www.example.com/about/team');
  });

  it('leaves normal paths unchanged aside from slash collapse', () => {
    const base = 'https://www.example.com/';
    expect(resolveUrl(base, '/a//b/c')).toBe('https://www.example.com/a/b/c');
  });
});
