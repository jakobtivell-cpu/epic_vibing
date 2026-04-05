// ---------------------------------------------------------------------------
// URL resolution helpers — safe handling of relative/absolute URLs.
// ---------------------------------------------------------------------------

/**
 * Turn a hostname, host/path, or http(s) URL into an absolute URL string
 * suitable for fetch/axios. Bare hosts (e.g. example.com) become https://example.com.
 * A single trailing slash on the path is stripped (root URLs become scheme://host).
 */
export function toAbsoluteHttpUrl(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

/** Path segments that are empty or only ASCII / percent-encoded quotes (bad hrefs). */
function isGarbagePathSegment(segment: string): boolean {
  const t = segment.trim();
  if (t.length === 0) return true;
  if (t === '%22' || /^%22+$/i.test(t)) return true;
  if (/^"+$/.test(t)) return true;
  return false;
}

/**
 * Normalize pathname: drop quote-only segments, collapse doubled slashes,
 * strip stray encoded/literal quotes from the path (generic — fixes IR links
 * like /%22/investors//%22).
 */
function sanitizePathname(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  const normalized = pathname.replace(/%22/gi, '"');
  const segments = normalized.split('/').filter((s) => !isGarbagePathSegment(s));
  if (segments.length === 0) return '/';
  return '/' + segments.join('/');
}

/**
 * Resolve a potentially relative URL against a base URL.
 * Returns null if the result is not a valid HTTP(S) URL.
 */
export function resolveUrl(base: string, href: string): string | null {
  try {
    let h = href.trim();
    if (h.length >= 2 && h.startsWith('"') && h.endsWith('"')) {
      h = h.slice(1, -1).trim();
    }
    const resolved = new URL(h, base);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return null;
    }
    resolved.pathname = sanitizePathname(resolved.pathname);
    return resolved.href;
  } catch {
    return null;
  }
}

/**
 * Check if two URLs share the same hostname (or one is a subdomain of the other).
 */
export function isSameSite(url1: string, url2: string): boolean {
  try {
    const h1 = new URL(url1).hostname.toLowerCase();
    const h2 = new URL(url2).hostname.toLowerCase();
    return h1 === h2 || h1.endsWith(`.${h2}`) || h2.endsWith(`.${h1}`);
  } catch {
    return false;
  }
}

/**
 * Extract the path portion of a URL, lowercased, for pattern matching.
 */
export function getPath(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return '';
  }
}
