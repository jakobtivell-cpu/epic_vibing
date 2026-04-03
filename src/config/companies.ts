import { CompanyProfile } from '../types';

// ---------------------------------------------------------------------------
// Default registry of 10 Swedish Large Cap companies.
//
// HOW TO SWAP COMPANIES:
//   Edit this file, or pass --config path/to/custom.json at runtime.
//   The pipeline code never references company names — only this config does.
//
// VERIFICATION NOTES:
//   All website URLs and IR paths were verified against public sites as of
//   April 2026. IR page structures change frequently; irHints are starting
//   points for the discovery heuristic, not hardcoded paths.
// ---------------------------------------------------------------------------

export const DEFAULT_COMPANIES: CompanyProfile[] = [
  {
    name: 'Volvo',
    ticker: 'VOLV B',
    website: 'https://www.volvogroup.com',
    irHints: ['/en/investors'],
    companyType: 'industrial',
    knownAliases: ['AB Volvo', 'Volvo Group'],
    entityWarnings: [
      'Do not confuse with Volvo Cars (volvocars.com) — separate company since 2010 Geely acquisition.',
    ],
    orgNumber: '556012-5790',
  },
  {
    name: 'Ericsson',
    ticker: 'ERIC B',
    website: 'https://www.ericsson.com',
    irHints: ['/en/investors'],
    companyType: 'industrial',
    knownAliases: ['Telefonaktiebolaget LM Ericsson', 'LM Ericsson'],
    entityWarnings: [],
    orgNumber: '556016-0680',
  },
  {
    name: 'H&M',
    ticker: 'HM B',
    website: 'https://hmgroup.com',
    irHints: ['/en/investors'],
    companyType: 'industrial',
    knownAliases: ['H & M Hennes & Mauritz AB', 'Hennes & Mauritz'],
    entityWarnings: [
      'Corporate site is hmgroup.com, not hm.com (which is the consumer store).',
    ],
    orgNumber: '556042-7220',
  },
  {
    name: 'Atlas Copco',
    ticker: 'ATCO A',
    website: 'https://www.atlascopcogroup.com',
    irHints: ['/en/investor-relations'],
    companyType: 'industrial',
    knownAliases: ['Atlas Copco AB', 'Atlas Copco Group'],
    entityWarnings: [],
    orgNumber: '556014-2720',
  },
  {
    name: 'Sandvik',
    ticker: 'SAND',
    website: 'https://www.home.sandvik',
    irHints: ['/en/investors'],
    companyType: 'industrial',
    knownAliases: ['Sandvik AB'],
    entityWarnings: [
      'Domain is home.sandvik (uses .sandvik TLD). Links may also appear under sandvik.com.',
    ],
    orgNumber: '556000-3468',
  },
  {
    name: 'SEB',
    ticker: 'SEB A',
    website: 'https://sebgroup.com',
    irHints: ['/en/investor-relations'],
    companyType: 'bank',
    knownAliases: ['Skandinaviska Enskilda Banken', 'SEB Group'],
    entityWarnings: [
      'SEB is a bank — financial statements use banking-specific terminology.',
      'Revenue equivalent for banks: "Total operating income" rather than "Omsättning".',
    ],
    orgNumber: '502032-9081',
  },
  {
    name: 'Investor',
    ticker: 'INVE B',
    website: 'https://www.investorab.com',
    irHints: ['/en/investors'],
    companyType: 'investment_company',
    knownAliases: ['Investor AB'],
    entityWarnings: [
      'Investor AB is a holding/investment company — revenue and EBIT are not comparable to industrial companies.',
      'Key metrics are NAV and total return rather than traditional revenue/EBIT.',
    ],
    orgNumber: '556013-8730',
  },
  {
    name: 'Hexagon',
    ticker: 'HEXA B',
    website: 'https://hexagon.com',
    irHints: ['/en/investors'],
    companyType: 'industrial',
    knownAliases: ['Hexagon AB'],
    entityWarnings: [],
    orgNumber: '556190-4460',
  },
  {
    name: 'Essity',
    ticker: 'ESSITY B',
    website: 'https://www.essity.com',
    irHints: ['/en/investors'],
    companyType: 'industrial',
    knownAliases: ['Essity AB', 'Essity Aktiebolag'],
    entityWarnings: [],
    orgNumber: '556325-5511',
  },
  {
    name: 'Alfa Laval',
    ticker: 'ALFA',
    website: 'https://www.alfalaval.com',
    irHints: ['/en/investors'],
    companyType: 'industrial',
    knownAliases: ['Alfa Laval AB'],
    entityWarnings: [],
    orgNumber: '556587-8054',
  },
];

/**
 * Look up a company by ticker (case-insensitive).
 * Returns undefined if not found.
 */
export function findByTicker(
  companies: CompanyProfile[],
  ticker: string,
): CompanyProfile | undefined {
  const normalized = ticker.trim().toUpperCase();
  return companies.find((c) => c.ticker.toUpperCase() === normalized);
}

/**
 * Load a custom company list from a JSON file.
 * The file must be an array of CompanyProfile objects.
 * Throws with a clear message if the file is malformed.
 */
export async function loadCustomCompanies(
  filePath: string,
): Promise<CompanyProfile[]> {
  const fs = await import('fs');
  const path = await import('path');

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Custom config file not found: ${resolved}`);
  }

  const raw = fs.readFileSync(resolved, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Custom config file is not valid JSON: ${resolved}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `Custom config must be a JSON array of company profiles, got ${typeof parsed}`,
    );
  }

  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (!entry.name || !entry.ticker || !entry.website) {
      throw new Error(
        `Company at index ${i} is missing required fields (name, ticker, website)`,
      );
    }
  }

  return parsed as CompanyProfile[];
}
