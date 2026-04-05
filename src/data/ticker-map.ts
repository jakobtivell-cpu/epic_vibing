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

const log = createLogger('ticker-map');

const TICKERS_PATH = join(__dirname, '..', '..', 'data', 'ticker.json');

interface TickerEntry {
  name: string;
  orgNumber?: string;
  /** Extra origins to try when the primary website / IR discovery fails (full URLs with scheme). */
  candidateDomains?: string[];
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
        tickerMap[key] = {
          name: String(o.name),
          ...(typeof o.orgNumber === 'string' ? { orgNumber: o.orgNumber } : {}),
          ...(Array.isArray(o.candidateDomains)
            ? {
                candidateDomains: o.candidateDomains.filter((x): x is string => typeof x === 'string'),
              }
            : {}),
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

function resolveTickerEntry(ticker: string): TickerEntry | null {
  if (Object.keys(tickerMap).length === 0) return null;

  if (tickerMap[ticker]) return tickerMap[ticker];

  const upper = ticker.toUpperCase();
  for (const [k, v] of Object.entries(tickerMap)) {
    if (k.toUpperCase() === upper) return v;
  }

  if (!upper.endsWith('.ST')) {
    const withSuffix = upper + '.ST';
    for (const [k, v] of Object.entries(tickerMap)) {
      if (k.toUpperCase() === withSuffix) return v;
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
