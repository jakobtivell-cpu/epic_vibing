// ---------------------------------------------------------------------------
// Label dictionaries for field extraction — Swedish + English, per company type.
// Longer/more specific labels are listed first so they match preferentially.
// ---------------------------------------------------------------------------

export interface LabelSet {
  revenue: string[];
  ebit: string[];
  employees: string[];
  ceo: string[];
}

export const INDUSTRIAL_LABELS: LabelSet = {
  revenue: [
    // Prefer longer phrases before bare "sales" (infographics / key figures)
    'sales, sek billion',
    'net sales, sek billion',
    'sales sek billion',
    // Sandvik and others use "Intäkter" as the primary consolidated revenue line — before generic omsättning/försäljning
    'intäkter',
    'net sales',
    'net revenue',
    'total revenue',
    'total income',
    'sales revenue',
    'revenues',
    'revenue',
    'sales',
    'nettoomsättning',
    'totala intäkter',
    'försäljning',
    'omsättning',
  ],
  ebit: [
    // Longer phrases first (direct / consolidated EBIT — not adjusted-only variants)
    'rörelseresultat före finansiella poster',
    'operating result before financial items',
    'profit before net financial items',
    'resultat från den löpande verksamheten',
    'resultat från verksamheten',
    'profit from operating activities',
    'ebit before items affecting comparability',
    'ebit före jämförelsestörande poster',
    'adjusted operating profit',
    'adjusted ebit',
    'earnings from operations',
    'adjusted operating income',
    'operating income',
    'operating earnings',
    'resultat före finansnetto',
    'operating profit/loss',
    'operating profit',
    'operating income',
    'operating result',
    'profit from operations',
    'ebit',
    'rörelseresultat',
    'rörelsens resultat',
    'rörelsevinst',
  ],
  employees: [
    'average number of employees',
    'number of employees at year-end',
    'number of employees',
    'employees at year-end',
    'full-time equivalents',
    'ftes',
    'headcount',
    'employees',
    'genomsnittligt antal anställda',
    'medelantal anställda',
    'antal anställda',
    'medarbetare',
  ],
  ceo: [
    'president and chief executive officer',
    'president and ceo',
    'president & ceo',
    'group ceo',
    'chief executive officer',
    'vd och koncernchef',
    'verkställande direktör och koncernchef',
    'verkställande direktör',
    'ceo',
    'vd',
  ],
};

/**
 * Bank revenue-equivalent lines — matched before industrial fallbacks.
 * Order: consolidated / total operating income first, then interest income.
 */
export const BANK_REVENUE_LABELS_PRIMARY: string[] = [
  'summa rörelseintäkter',
  'totala rörelseintäkter',
  'total operating income',
  'räntenetto',
  'net interest income',
];

/**
 * Bank operating-result lines — matched before industrial EBIT fallbacks.
 */
export const BANK_EBIT_LABELS_PRIMARY: string[] = [
  'operating profit',
  'rörelseresultat',
  'profit before impairments',
  'profit before loan losses',
  'operating profit before impairments',
  'result before credit losses',
  'resultat före kreditförluster',
  'operating result',
  'result before tax',
];

function dedupeLabels(primary: string[], rest: string[]): string[] {
  const seen = new Set(primary.map((s) => s.toLowerCase()));
  const out = [...primary];
  for (const r of rest) {
    if (seen.has(r.toLowerCase())) continue;
    seen.add(r.toLowerCase());
    out.push(r);
  }
  return out;
}

export const BANK_LABELS: LabelSet = {
  revenue: dedupeLabels(BANK_REVENUE_LABELS_PRIMARY, [
    'total income',
    ...INDUSTRIAL_LABELS.revenue,
  ]),
  ebit: dedupeLabels(BANK_EBIT_LABELS_PRIMARY, INDUSTRIAL_LABELS.ebit),
  employees: INDUSTRIAL_LABELS.employees,
  ceo: [
    'president and group chief executive',
    ...INDUSTRIAL_LABELS.ceo,
  ],
};

export const INVESTMENT_LABELS: LabelSet = {
  revenue: [
    'management fee income',
    'dividend income',
    'total return',
    ...INDUSTRIAL_LABELS.revenue,
  ],
  ebit: INDUSTRIAL_LABELS.ebit,
  employees: INDUSTRIAL_LABELS.employees,
  ceo: INDUSTRIAL_LABELS.ceo,
};

export const REAL_ESTATE_EBIT_LABELS_PRIMARY: string[] = [
  'förvaltningsresultat',
  'income from property management',
  'operating surplus',
  'driftnetto',
];

export const REAL_ESTATE_LABELS: LabelSet = {
  revenue: INDUSTRIAL_LABELS.revenue,
  ebit: dedupeLabels(REAL_ESTATE_EBIT_LABELS_PRIMARY, INDUSTRIAL_LABELS.ebit),
  employees: INDUSTRIAL_LABELS.employees,
  ceo: INDUSTRIAL_LABELS.ceo,
};

// ---------------------------------------------------------------------------
// Sustainability / GHG emission labels
// ---------------------------------------------------------------------------

export interface SustainabilityLabelSet {
  scope1: string[];
  scope2: string[];
  scope2MarketBased: string[];
  scope2LocationBased: string[];
}

export const SUSTAINABILITY_LABELS: SustainabilityLabelSet = {
  scope1: [
    'scope 1',
    'direkta utsläpp',
    'direkta växthusgasutsläpp',
    'direct emissions',
    'direct ghg emissions',
  ],
  scope2: [
    'scope 2',
    'indirekta utsläpp',
    'indirekta växthusgasutsläpp',
    'indirect emissions',
    'energy indirect emissions',
  ],
  scope2MarketBased: [
    'scope 2 (market-based)',
    'scope 2 (market based)',
    'scope 2, market-based',
    'scope 2 market-based',
    'scope 2 market based',
    'market-based',
    'market based',
    'marknadsbaserad',
  ],
  scope2LocationBased: [
    'scope 2 (location-based)',
    'scope 2 (location based)',
    'scope 2, location-based',
    'scope 2 location-based',
    'scope 2 location based',
    'location-based',
    'location based',
    'platsbaserad',
  ],
};
