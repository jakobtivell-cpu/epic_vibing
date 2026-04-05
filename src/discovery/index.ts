export { discoverIrPage } from './ir-finder';
export {
  discoverAnnualReport,
  quickScanPdfCandidatesOnPage,
} from './report-ranker';
export type { DiscoverAnnualReportOptions } from './report-ranker';
export { tryPlaywrightFallback } from './playwright-fallback';
export { searchDiscovery, directPdfSearch, deriveShortNames } from './search-discovery';
export type { SearchDiscoveryResult } from './search-discovery';
export { collectPublicationHubUrls } from './report-corpus';
export { filterAndRankReportCandidatesForEntity } from './candidate-ranking';
