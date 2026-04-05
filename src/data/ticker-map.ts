// ---------------------------------------------------------------------------
// Ticker map — optional enrichment layer for name resolution.
//
// Loads data/ticker.json at startup. If the file is missing or malformed,
// logs a single warning and continues. The engine is fully operational
// without it. The map is a name-resolution hint only — it never changes
// the fallback chain order, company type inference, or scoring.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import { join } from 'path';
import { createLogger } from '../utils/logger';
import { toAbsoluteHttpUrl } from '../utils/url-helpers';

const log = createLogger('ticker-map');

const TICKERS_PATH = join(__dirname, '..', '..', 'data', 'ticker.json');

interface TickerEntry {
  name: string;
  orgNumber?: string;
  /** Extra origins to try when the primary website / IR discovery fails (full URLs with scheme). */
  candidateDomains?: string[];
  /** Verified IR page URL — pipeline skips heuristic IR discovery when set. */
  irPage?: string;
}

/** Raw map: ticker symbol → canonical legal entity name. */
let tickerMap: Record<string, TickerEntry> = {};

let loaded = false;

/**
 * Attempt to load data/ticker.json once. Subsequent calls are no-ops.
 * Never throws — a missing or corrupt file is a single warning, not a crash.
 *
 * Supports two formats:
 *   - Simple:  { "SEB-A.ST": "Skandinaviska Enskilda Banken AB (publ)" }
 *   - Rich:    { "SEB-A.ST": { "name": "...", "orgNumber": "502032-9081" } }
 */
export function loadTickerMap(): void {
  if (loaded) return;
  loaded = true;

  try {
    if (!fs.existsSync(TICKERS_PATH)) {
      log.warn(`Ticker file not found at ${TICKERS_PATH} — running without ticker enrichment`);
      return;
    }
    const raw = fs.readFileSync(TICKERS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      log.warn('Ticker file is not a JSON object — ignoring');
      return;
    }

    // Normalize both simple (string) and rich (object) formats
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val === 'string') {
        tickerMap[key] = { name: val };
      } else if (typeof val === 'object' && val !== null && 'name' in val) {
        const o = val as Record<string, unknown>;
        const irRaw = o.irPage;
        const irNormalized =
          typeof irRaw === 'string' && irRaw.trim() ? toAbsoluteHttpUrl(irRaw.trim()) : undefined;
        tickerMap[key] = {
          name: String(o.name),
          ...(typeof o.orgNumber === 'string' ? { orgNumber: o.orgNumber } : {}),
          ...(Array.isArray(o.candidateDomains)
            ? {
                candidateDomains: o.candidateDomains
                  .filter((x): x is string => typeof x === 'string')
                  .map((s) => toAbsoluteHttpUrl(s))
                  .filter((x): x is string => x !== null),
              }
            : {}),
          ...(irNormalized ? { irPage: irNormalized } : {}),
        };
      }
    }

    log.info(`Loaded ${Object.keys(tickerMap).length} ticker mappings from ${TICKERS_PATH}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to load ticker file: ${msg} — running without ticker enrichment`);
  }
}

/**
 * Look up a ticker symbol and return its canonical legal entity name.
 * Returns `null` if the ticker is not in the map or the map is not loaded.
 * Performs a case-insensitive match and auto-appends ".ST" if missing.
 */
export function resolveTicker(ticker: string): string | null {
  const entry = resolveTickerEntry(ticker);
  return entry?.name ?? null;
}

/**
 * Look up a ticker symbol and return the org number if available.
 */
export function resolveOrgNumber(ticker: string): string | null {
  const entry = resolveTickerEntry(ticker);
  return entry?.orgNumber ?? null;
}

export function resolveCandidateDomains(ticker: string): string[] | null {
  const entry = resolveTickerEntry(ticker);
  const d = entry?.candidateDomains;
  return d && d.length > 0 ? d : null;
}

export function resolveIrPage(ticker: string): string | null {
  const entry = resolveTickerEntry(ticker);
  return entry?.irPage ?? null;
}

/**
 * Normalize user ticker input to Nasdaq Stockholm style before map lookup.
 * Examples: "VOLV B" / "VOLV-B" → "VOLV-B.ST", "SAND" → "SAND.ST".
 * Leaves free-text company names (e.g. "Securitas", "H&M") unchanged.
 */
export function normalizeTickerForLookup(raw: string): string {
  const t = raw.trim();
  if (t.length === 0) return t;

  const upper = t.toUpperCase().replace(/\s+/g, ' ');

  if (/\.ST$/i.test(upper)) {
    return upper.replace(/\s/g, '');
  }

  const spaced = upper.match(/^([A-Z0-9][A-Z0-9.&-]*)\s+([A-Z])$/);
  if (spaced) {
    return `${spaced[1]}-${spaced[2]}.ST`;
  }

  const hyphen = upper.match(/^([A-Z0-9][A-Z0-9.&-]*)-([A-Z])$/);
  if (hyphen) {
    return `${hyphen[1]}-${hyphen[2]}.ST`;
  }

  if (/^[A-Z]{2,6}$/.test(upper)) {
    return `${upper}.ST`;
  }

  return t;
}

function resolveTickerEntry(ticker: string): TickerEntry | null {
  if (Object.keys(tickerMap).length === 0) return null;

  const tryKeys = new Set<string>();
  const raw = ticker.trim();
  if (raw.length === 0) return null;
  tryKeys.add(raw);
  tryKeys.add(normalizeTickerForLookup(raw));

  for (const key of tryKeys) {
    if (!key) continue;
    if (tickerMap[key]) return tickerMap[key];
    const upper = key.toUpperCase();
    for (const [k, v] of Object.entries(tickerMap)) {
      if (k.toUpperCase() === upper) return v;
    }
    if (!upper.endsWith('.ST')) {
      const withSuffix = `${upper}.ST`;
      for (const [k, v] of Object.entries(tickerMap)) {
        if (k.toUpperCase() === withSuffix) return v;
      }
    }
  }

  return null;
}

/**
 * Return the full ticker map (for deduplication or other bulk operations).
 * Returns an empty object if the map is not loaded.
 */
export function getTickerMap(): Readonly<Record<string, TickerEntry>> {
  return tickerMap;
}
