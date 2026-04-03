// ---------------------------------------------------------------------------
// PDF text extraction — wrapper around pdf-parse with whitespace normalization,
// scanned-PDF detection, debug caching, and graceful error handling.
//
// This module returns RAW text. Interpretation (field extraction) is separate.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import pdfParse from 'pdf-parse';
import { CACHE_DIR } from '../config/settings';
import { createLogger } from '../utils/logger';

const log = createLogger('text-extract');

const SUSPICIOUSLY_SHORT_THRESHOLD = 5_000;

export interface PdfTextResult {
  text: string | null;
  pageCount: number;
  textLength: number;
  /** True if text < 5000 chars — likely a scanned/image-based PDF. */
  suspiciouslyShort: boolean;
  extractionError?: string;
}

// ---------------------------------------------------------------------------
// Whitespace normalization
// ---------------------------------------------------------------------------

/**
 * Collapse runs of spaces/tabs to a single space within each line,
 * while preserving line breaks that indicate structural boundaries
 * (table rows, headings, paragraphs). Runs of 3+ blank lines are
 * collapsed to 2 to keep section separation visible.
 */
function normalizeWhitespace(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n');
}

// ---------------------------------------------------------------------------
// Debug cache
// ---------------------------------------------------------------------------

function writeCacheFile(
  text: string,
  ticker: string | undefined,
  fiscalYear: number | null | undefined,
): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }

    const slug = ticker
      ? ticker.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
      : 'unknown';
    const yearStr = fiscalYear != null ? String(fiscalYear) : 'unknown_year';
    const cacheFile = path.join(CACHE_DIR, `${slug}-${yearStr}.txt`);

    fs.writeFileSync(cacheFile, text, 'utf-8');
    log.debug(`Cached extracted text to ${cacheFile} (${text.length} chars)`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to write cache file: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface TextExtractorOptions {
  ticker?: string;
  fiscalYear?: number | null;
  /** Skip writing the debug cache file. Default: false. */
  skipCache?: boolean;
}

export async function extractTextFromPdf(
  filepath: string,
  options: TextExtractorOptions = {},
): Promise<PdfTextResult> {
  log.info(`Extracting text from ${filepath}`);

  if (!fs.existsSync(filepath)) {
    log.error(`PDF file not found: ${filepath}`);
    return {
      text: null,
      pageCount: 0,
      textLength: 0,
      suspiciouslyShort: true,
      extractionError: `PDF file not found: ${filepath}`,
    };
  }

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(filepath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Failed to read PDF file: ${msg}`);
    return {
      text: null,
      pageCount: 0,
      textLength: 0,
      suspiciouslyShort: true,
      extractionError: `Failed to read PDF: ${msg}`,
    };
  }

  // Check PDF magic bytes
  if (buffer.length < 5 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    log.error('File does not appear to be a valid PDF (missing magic bytes)');
    return {
      text: null,
      pageCount: 0,
      textLength: 0,
      suspiciouslyShort: true,
      extractionError: 'File does not appear to be a valid PDF (missing %PDF- header)',
    };
  }

  let result;
  try {
    result = await pdfParse(buffer);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`pdf-parse failed: ${msg}`);
    return {
      text: null,
      pageCount: 0,
      textLength: 0,
      suspiciouslyShort: true,
      extractionError: `pdf-parse extraction failed: ${msg}`,
    };
  }

  const normalized = normalizeWhitespace(result.text);
  const textLength = normalized.length;
  const pageCount = result.numpages;
  const suspiciouslyShort = textLength < SUSPICIOUSLY_SHORT_THRESHOLD;

  if (suspiciouslyShort) {
    log.warn(
      `Extracted only ${textLength} chars from ${pageCount} pages — likely scanned/image-based PDF`,
    );
  } else {
    log.info(`Extracted ${textLength} characters from ${pageCount} pages`);
  }

  // Write debug cache
  if (!options.skipCache) {
    writeCacheFile(normalized, options.ticker, options.fiscalYear);
  }

  return {
    text: normalized,
    pageCount,
    textLength,
    suspiciouslyShort,
  };
}
