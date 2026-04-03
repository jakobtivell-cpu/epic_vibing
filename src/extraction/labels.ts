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
    'net sales',
    'net revenue',
    'total revenue',
    'total income',
    'sales revenue',
    'revenue',
    'sales',
    'nettoomsättning',
    'totala intäkter',
    'försäljning',
    'omsättning',
    'intäkter',
  ],
  ebit: [
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

export const BANK_LABELS: LabelSet = {
  revenue: [
    'total operating income',
    'totala rörelseintäkter',
    'net interest income',
    'räntenetto',
    'total income',
    ...INDUSTRIAL_LABELS.revenue,
  ],
  ebit: [
    'operating profit before impairments',
    'profit before credit losses',
    ...INDUSTRIAL_LABELS.ebit,
  ],
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
