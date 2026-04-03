// ---------------------------------------------------------------------------
// Sustainability data extraction — Scope 1 and Scope 2 CO2 emissions.
//
// Designed as a BONUS extraction layer: failures here must never block or
// slow core financial extraction. All return paths produce valid results
// (with nulls and explanatory notes when data is missing).
// ---------------------------------------------------------------------------

import { Scope2Methodology } from '../types';
import { SUSTAINABILITY_LABELS } from './labels';
import { createLogger } from '../utils/logger';

const log = createLogger('sustainability');

export interface SustainabilityExtractionResult {
  scope1_co2_tonnes: number | null;
  scope2_co2_tonnes: number | null;
  methodology: Scope2Methodology | null;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Unit detection — convert kt, Mton, etc. to tonnes
// ---------------------------------------------------------------------------

const UNIT_MULTIPLIERS: Array<{ pattern: RegExp; factor: number }> = [
  { pattern: /\bMton\b|\bmega.?tonn/i, factor: 1_000_000 },
  { pattern: /\bkt\b|\bkiloton/i, factor: 1_000 },
  { pattern: /\bton(?:ne)?s?\b|\btCO2e?\b|\bton\s*CO2/i, factor: 1 },
];

function detectUnitMultiplier(context: string): number {
  for (const { pattern, factor } of UNIT_MULTIPLIERS) {
    if (pattern.test(context)) return factor;
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Number parsing for CO2 values
// ---------------------------------------------------------------------------

function parseCO2Number(raw: string): number | null {
  let s = raw.trim();

  s = s.replace(/,(\d{3})/g, '$1');
  s = s.replace(/(?<=\d)\s+(?=\d{3}(?!\d))/g, '');

  const dotGroups = s.match(/\.(\d+)/g);
  if (dotGroups && dotGroups.length === 1 && dotGroups[0].length === 4) {
    // European thousand separator: 12.500
    s = s.replace(/\./g, '');
  }

  const m = s.match(/[-–−]?\d+(?:\.\d+)?/);
  if (!m) return null;

  const value = parseFloat(m[0].replace(/[–−]/g, '-'));
  if (isNaN(value) || !isFinite(value)) return null;

  return value;
}

// ---------------------------------------------------------------------------
// Scope value finder — searches lines for labeled CO2 numbers
// ---------------------------------------------------------------------------

function findCO2Value(
  lines: string[],
  labels: string[],
): number | null {
  for (const label of labels) {
    const labelLower = label.toLowerCase();

    for (let i = 0; i < lines.length; i++) {
      const lineLower = lines[i].toLowerCase();
      const idx = lineLower.indexOf(labelLower);
      if (idx < 0) continue;

      // Build a search window: rest of this line + next 2 lines
      let searchWindow = [
        lines[i].substring(idx + label.length),
        lines[i + 1] || '',
        lines[i + 2] || '',
      ].join(' ');

      // Strip other scope references so we don't parse "2" from "Scope 2" as a CO2 value
      searchWindow = searchWindow.replace(/\bscope\s*[1-3]\b/gi, ' ');

      const multiplier = detectUnitMultiplier(searchWindow);

      const numberPatterns = searchWindow.match(
        /[-–−]?\d{1,3}(?:[,.\s]\d{3})*(?:\.\d+)?/g,
      );
      if (!numberPatterns) continue;

      for (const numStr of numberPatterns) {
        if (/^20[12]\d$/.test(numStr.trim())) continue;

        const value = parseCO2Number(numStr);
        if (value === null || value === 0) continue;

        const tonnes = Math.round(Math.abs(value) * multiplier);
        // Large Cap companies emit at least ~10 tonnes; reject implausibly small values
        if (tonnes >= 10 && tonnes <= 100_000_000) {
          log.debug(`Found "${label}": ${tonnes} tonnes (raw: ${numStr}, multiplier: ${multiplier})`);
          return tonnes;
        }
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Scope 2 — three-pass search: market-based → location-based → generic
// ---------------------------------------------------------------------------

function findScope2(
  lines: string[],
): { value: number; methodology: Scope2Methodology | null } | null {
  // Pass 1: market-based (preferred per assignment rules)
  const marketResult = findCO2Value(lines, SUSTAINABILITY_LABELS.scope2MarketBased);
  if (marketResult !== null) {
    return { value: marketResult, methodology: 'market-based' };
  }

  // Pass 2: location-based
  const locationResult = findCO2Value(lines, SUSTAINABILITY_LABELS.scope2LocationBased);
  if (locationResult !== null) {
    return { value: locationResult, methodology: 'location-based' };
  }

  // Pass 3: generic "scope 2" — detect methodology from context
  const genericResult = findCO2Value(lines, SUSTAINABILITY_LABELS.scope2);
  if (genericResult !== null) {
    const methodology = detectMethodologyFromContext(lines);
    return { value: genericResult, methodology };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Methodology detection — broader context search
// ---------------------------------------------------------------------------

function detectMethodologyFromContext(lines: string[]): Scope2Methodology | null {
  const text = lines.join(' ').toLowerCase();

  const scope2Idx = text.indexOf('scope 2');
  if (scope2Idx < 0) return null;

  const window = text.substring(
    Math.max(0, scope2Idx - 200),
    Math.min(text.length, scope2Idx + 500),
  );

  const hasMarket = /market.based/i.test(window);
  const hasLocation = /location.based/i.test(window);

  if (hasMarket) return 'market-based';
  if (hasLocation) return 'location-based';
  return null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function extractSustainabilityData(
  annualReportText: string | null,
  sustainabilityReportText: string | null,
): SustainabilityExtractionResult {
  const notes: string[] = [];
  const searchTexts: string[] = [];

  if (sustainabilityReportText) {
    searchTexts.push(sustainabilityReportText);
    notes.push('Searched standalone sustainability report');
  }

  if (annualReportText) {
    const isCombined = /sustainability|hållbarhet/i.test(
      annualReportText.substring(0, 5000),
    );
    if (isCombined || searchTexts.length === 0) {
      searchTexts.push(annualReportText);
      notes.push(
        isCombined
          ? 'Annual report includes sustainability content'
          : 'Searched annual report for sustainability data',
      );
    }
  }

  if (searchTexts.length === 0) {
    return {
      scope1_co2_tonnes: null,
      scope2_co2_tonnes: null,
      methodology: null,
      notes: ['No PDF text available for sustainability extraction'],
    };
  }

  let scope1: number | null = null;
  let scope2: number | null = null;
  let methodology: Scope2Methodology | null = null;

  for (const text of searchTexts) {
    const lines = text.split(/\n/).map((l) => l.trim()).filter((l) => l.length > 0);

    if (scope1 === null) {
      scope1 = findCO2Value(lines, SUSTAINABILITY_LABELS.scope1);
    }

    if (scope2 === null) {
      const scope2Result = findScope2(lines);
      if (scope2Result) {
        scope2 = scope2Result.value;
        methodology = scope2Result.methodology;
      }
    }
  }

  if (scope1 !== null) log.info(`Scope 1 CO2: ${scope1} tonnes`);
  if (scope2 !== null) log.info(`Scope 2 CO2: ${scope2} tonnes (${methodology ?? 'unknown methodology'})`);

  if (scope1 === null && scope2 === null) {
    notes.push('No Scope 1/2 CO2 data found in available reports');
  }

  return {
    scope1_co2_tonnes: scope1,
    scope2_co2_tonnes: scope2,
    methodology,
    notes,
  };
}
