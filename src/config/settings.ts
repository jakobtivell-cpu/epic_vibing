// ---------------------------------------------------------------------------
// Global settings — tunable constants for the scraper pipeline.
// ---------------------------------------------------------------------------

import * as path from 'path';

/**
 * Project root for `output/`, `downloads/`, and `cache/`.
 * From compiled `dist/src/config`, `../../` would wrongly land in `dist/`; use three levels up
 * so paths match `server.ts` (`join(ROOT, 'output', 'results.json')` at deploy root).
 * From source `src/config`, two levels up is the repo root.
 * Override with `APP_ROOT` for custom layouts (e.g. Azure).
 */
function resolveProjectRoot(): string {
  const fromEnv = process.env.APP_ROOT?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  if (path.basename(path.resolve(__dirname, '../..')) === 'dist') {
    return path.resolve(__dirname, '../../../');
  }
  return path.resolve(__dirname, '../..');
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Repo / deployment root (see `resolveProjectRoot`). Exported for `data/ticker.json` and similar. */
export const PROJECT_ROOT = resolveProjectRoot();

/** Base milliseconds to wait between HTTP requests to the same domain. */
export const SAME_DOMAIN_DELAY_MS = 2_000;

/** Random jitter added to per-domain delay (±this value in ms). */
export const DOMAIN_DELAY_JITTER_MS = 1_000;

/** Base delay when --slow flag is active. */
export const SLOW_MODE_DELAY_MS = 8_000;

/** Exponential backoff sequence for HTTP 403 responses (ms). */
export const RATE_LIMIT_BACKOFF_SEQUENCE = [30_000, 60_000, 120_000, 300_000];

/**
 * Shorter backoff for HTTP 429 so a single host cannot burn most of
 * `--timeout-per-company` wall-clock before the pipeline can fall back.
 */
export const RATE_LIMIT_BACKOFF_SEQUENCE_429 = [5_000, 12_000, 25_000, 45_000];

/** Maximum retries per HTTP request before giving up. */
export const MAX_RETRIES = 3;

/** HTTP request timeout in milliseconds. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** PDF binary GET timeout (large annual reports, slow CDNs). */
export const PDF_DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * When income statements use EUR millions, convert to MSEK with this approximate rate.
 * Official reports often footnote the average rate; this is a generic fallback.
 */
export const EUR_MILLIONS_TO_MSEK_APPROX = 11.25;

/**
 * When income statements use USD millions, convert to MSEK with this approximate rate.
 * Mining / dual-listed issuers often report in U.S. dollars; footnotes give the average rate.
 */
export const USD_MILLIONS_TO_MSEK_APPROX = 10.8;

/** GBP millions → MSEK (approximate). UK-listed dual-listed issuers (e.g. AstraZeneca). */
export const GBP_MILLIONS_TO_MSEK_APPROX = 13.5;

/** NOK millions → MSEK (approximate). Norwegian issuers (e.g. DNB, Kongsberg). */
export const NOK_MILLIONS_TO_MSEK_APPROX = 1.0;

/** DKK millions → MSEK (approximate). Danish issuers. */
export const DKK_MILLIONS_TO_MSEK_APPROX = 1.55;

/** Maximum PDF candidates to try per fallback step before advancing. */
export const MAX_CANDIDATES_PER_STEP = 5;

/**
 * Legacy default User-Agent (exported for tooling). Outbound HTTP uses a per-domain
 * rotating pool in `src/utils/http-client.ts`.
 */
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** Directory where downloaded PDFs are cached. */
export const DOWNLOADS_DIR = path.join(PROJECT_ROOT, 'downloads');

/** Directory where results.json and run logs are written. */
export const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');

/** Path to the main results file. */
export const RESULTS_PATH = path.join(OUTPUT_DIR, 'results.json');

/** Path to the run summary file. */
export const RUN_SUMMARY_PATH = path.join(OUTPUT_DIR, 'run_summary.json');

/** Directory where extracted PDF text is cached for debugging. */
export const CACHE_DIR = path.join(PROJECT_ROOT, 'cache');

/** After SIGTERM, wait this long before SIGKILL on a per-company pipeline child (see --timeout-per-company). */
export const TIMEOUT_CHILD_SIGKILL_GRACE_MS = 5_000;

/** Upper bound of candidate domains processed in multi-domain IR cycle. */
export const MAX_CANDIDATE_DOMAINS = envInt('MAX_CANDIDATE_DOMAINS', 8);

/** Soft per-stage budget for IR/report discovery blocks (ms). */
export const STAGE_DISCOVERY_BUDGET_MS = envInt('STAGE_DISCOVERY_BUDGET_MS', 90_000);

/** Soft per-stage budget for fallback source fetches (ms). */
export const STAGE_FALLBACK_BUDGET_MS = envInt('STAGE_FALLBACK_BUDGET_MS', 35_000);
