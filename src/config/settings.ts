// ---------------------------------------------------------------------------
// Global settings — tunable constants for the scraper pipeline.
// ---------------------------------------------------------------------------

import * as path from 'path';

/** Milliseconds to wait between HTTP requests to the same domain. */
export const SAME_DOMAIN_DELAY_MS = 1_000;

/** Milliseconds to wait between processing different companies. */
export const INTER_COMPANY_DELAY_MS = 2_000;

/** Maximum retries per HTTP request before giving up. */
export const MAX_RETRIES = 3;

/** HTTP request timeout in milliseconds. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** User-Agent string sent with every request. */
export const USER_AGENT =
  'Mozilla/5.0 (compatible; AcademicScraper/1.0; +student-project)';

/** Directory where downloaded PDFs are cached. */
export const DOWNLOADS_DIR = path.resolve(__dirname, '../../downloads');

/** Directory where results.json and run logs are written. */
export const OUTPUT_DIR = path.resolve(__dirname, '../../output');

/** Path to the main results file. */
export const RESULTS_PATH = path.join(OUTPUT_DIR, 'results.json');

/** Path to the run summary file. */
export const RUN_SUMMARY_PATH = path.join(OUTPUT_DIR, 'run_summary.json');

/** Directory where extracted PDF text is cached for debugging. */
export const CACHE_DIR = path.resolve(__dirname, '../../cache');
