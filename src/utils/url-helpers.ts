// ---------------------------------------------------------------------------
// URL resolution helpers — safe handling of relative/absolute URLs.
// ---------------------------------------------------------------------------

/**
 * Resolve a potentially relative URL against a base URL.
 * Returns null if the result is not a valid HTTP(S) URL.
 */
export function resolveUrl(base: string, href: string): string | null {
  try {
    const resolved = new URL(href, base);
    if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
      return resolved.href;
    }
    return null;
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
