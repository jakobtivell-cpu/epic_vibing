// ---------------------------------------------------------------------------
// PDF downloader — fetches a remote PDF and caches it locally.
// Skips download if a cached copy exists (unless --force).
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { StageResult } from '../types';
import { DOWNLOADS_DIR, PDF_DOWNLOAD_TIMEOUT_MS } from '../config/settings';
import { fetchBinary } from '../utils/http-client';
import { createLogger } from '../utils/logger';

const log = createLogger('download');

function sanitizeTicker(ticker: string): string {
  return ticker
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

function urlHash8(url: string): string {
  return createHash('sha256').update(url).digest('hex').substring(0, 8);
}

function buildFilename(ticker: string, year: number | null, suffix: string, url: string): string {
  const slug = sanitizeTicker(ticker);
  if (year !== null) {
    return `${slug}_${String(year)}_${suffix}.pdf`;
  }
  return `${slug}_unknown_year_${urlHash8(url)}_${suffix}.pdf`;
}

export async function downloadPdf(
  url: string,
  ticker: string,
  fiscalYear: number | null,
  force: boolean,
  suffix: string = 'annual_report',
): Promise<StageResult<string>> {
  const start = Date.now();
  const filename = buildFilename(ticker, fiscalYear, suffix, url);
  const filepath = path.join(DOWNLOADS_DIR, filename);

  if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  }

  if (!force && fs.existsSync(filepath)) {
    const stats = fs.statSync(filepath);
    if (stats.size > 0) {
      log.info(
        `Using cached PDF: ${filename} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`,
      );
      return { status: 'success', value: filepath, durationMs: Date.now() - start };
    }
    log.warn(`Cached file is empty — re-downloading: ${filename}`);
  }

  log.info(`Downloading PDF: ${url}`);
  const result = await fetchBinary(url, PDF_DOWNLOAD_TIMEOUT_MS);

  if (!result.ok) {
    return {
      status: 'failed',
      value: null,
      error: `Download failed: ${result.error.message}`,
      durationMs: Date.now() - start,
    };
  }

  if (
    !result.contentType.includes('pdf') &&
    !result.contentType.includes('octet-stream')
  ) {
    log.warn(`Unexpected content-type "${result.contentType}" — saving anyway`);
  }

  if (result.data.length < 1_000) {
    return {
      status: 'failed',
      value: null,
      error: `Downloaded file too small (${result.data.length} bytes) — likely not a valid PDF`,
      durationMs: Date.now() - start,
    };
  }

  const magic = result.data.subarray(0, 5).toString('ascii');
  if (magic !== '%PDF-') {
    return {
      status: 'failed',
      value: null,
      error: `File does not start with PDF magic bytes (got: "${magic}")`,
      durationMs: Date.now() - start,
    };
  }

  fs.writeFileSync(filepath, result.data);
  const sizeMb = (result.data.length / 1024 / 1024).toFixed(1);
  log.info(`Saved ${filename} (${sizeMb} MB)`);

  return { status: 'success', value: filepath, durationMs: Date.now() - start };
}
