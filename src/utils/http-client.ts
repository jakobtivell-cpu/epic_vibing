// ---------------------------------------------------------------------------
// HTTP client — axios wrapper with retry, timeout, per-domain rate limiting,
// jitter, exponential backoff on 403/429, and configurable slow mode.
// ---------------------------------------------------------------------------

import axios, { AxiosInstance, AxiosResponse, AxiosError } from 'axios';
import {
  USER_AGENT,
  REQUEST_TIMEOUT_MS,
  PDF_DOWNLOAD_TIMEOUT_MS,
  MAX_RETRIES,
  SAME_DOMAIN_DELAY_MS,
  DOMAIN_DELAY_JITTER_MS,
  SLOW_MODE_DELAY_MS,
  RATE_LIMIT_BACKOFF_SEQUENCE,
} from '../config/settings';
import { createLogger } from './logger';

const log = createLogger('http');

// ---------------------------------------------------------------------------
// Slow-mode toggle (set via CLI --slow flag)
// ---------------------------------------------------------------------------

let slowMode = false;

export function setSlowMode(enabled: boolean): void {
  slowMode = enabled;
  log.info(`Slow mode ${enabled ? 'enabled' : 'disabled'} — base delay ${enabled ? SLOW_MODE_DELAY_MS : SAME_DOMAIN_DELAY_MS}ms`);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HttpResponse {
  status: number;
  data: string;
  url: string;
  finalUrl: string;
}

export interface HttpError {
  message: string;
  status?: number;
  code?: string;
}

export type HttpResult =
  | { ok: true; response: HttpResponse }
  | { ok: false; error: HttpError };

// ---------------------------------------------------------------------------
// Per-domain rate limiting with jitter
// ---------------------------------------------------------------------------

const domainTimestamps = new Map<string, number>();
const domainBackoffIndex = new Map<string, number>();

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

function getBaseDelay(): number {
  return slowMode ? SLOW_MODE_DELAY_MS : SAME_DOMAIN_DELAY_MS;
}

function jitter(): number {
  return Math.round((Math.random() * 2 - 1) * DOMAIN_DELAY_JITTER_MS);
}

async function rateLimitDelay(domain: string): Promise<void> {
  const last = domainTimestamps.get(domain);
  if (last) {
    const elapsed = Date.now() - last;
    const delay = getBaseDelay() + jitter();
    const wait = delay - elapsed;
    if (wait > 0) {
      log.debug(`Rate limiting: waiting ${wait}ms for ${domain}`);
      await sleep(wait);
    }
  }
  domainTimestamps.set(domain, Date.now());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Exponential backoff for 403/429
// ---------------------------------------------------------------------------

async function handleRateLimitBackoff(domain: string): Promise<boolean> {
  const idx = domainBackoffIndex.get(domain) ?? 0;
  if (idx >= RATE_LIMIT_BACKOFF_SEQUENCE.length) {
    log.error(`RATE_LIMITED: all backoff retries exhausted for ${domain}`);
    return false;
  }
  const delay = RATE_LIMIT_BACKOFF_SEQUENCE[idx];
  log.warn(`RATE_LIMITED: ${domain} — backing off ${delay / 1000}s (attempt ${idx + 1}/${RATE_LIMIT_BACKOFF_SEQUENCE.length})`);
  domainBackoffIndex.set(domain, idx + 1);
  await sleep(delay);
  domainTimestamps.set(domain, Date.now());
  return true;
}

/** Reset backoff counter for a domain after a successful request. */
function resetBackoff(domain: string): void {
  if (domainBackoffIndex.has(domain)) {
    domainBackoffIndex.delete(domain);
  }
}

// ---------------------------------------------------------------------------
// Shared axios instance
// ---------------------------------------------------------------------------

const client: AxiosInstance = axios.create({
  timeout: REQUEST_TIMEOUT_MS,
  headers: { 'User-Agent': USER_AGENT },
  maxRedirects: 5,
  responseType: 'text',
  transformResponse: [(data) => data],
});

// ---------------------------------------------------------------------------
// HEAD check
// ---------------------------------------------------------------------------

export interface HeadResult {
  exists: boolean;
  status?: number;
  contentType?: string;
  finalUrl?: string;
}

export async function headCheck(
  url: string,
  timeoutMs: number = 10_000,
): Promise<HeadResult> {
  const domain = extractDomain(url);
  await rateLimitDelay(domain);

  try {
    log.debug(`HEAD ${url}`);
    const resp = await client.head(url, {
      timeout: timeoutMs,
      validateStatus: (s) => s < 400,
    });

    const contentType =
      (resp.headers['content-type'] as string | undefined) ?? '';
    const finalUrl =
      resp.request?.res?.responseUrl ?? resp.config.url ?? url;

    resetBackoff(domain);
    return { exists: true, status: resp.status, contentType, finalUrl };
  } catch (err) {
    const axErr = err as AxiosError;
    const status = axErr.response?.status;
    if (status === 403 || status === 429) {
      const canRetry = await handleRateLimitBackoff(domain);
      if (canRetry) return headCheck(url, timeoutMs);
    }
    return { exists: false, status };
  }
}

// ---------------------------------------------------------------------------
// GET (text/HTML)
// ---------------------------------------------------------------------------

export async function fetchPage(
  url: string,
  timeoutMs?: number,
): Promise<HttpResult> {
  const domain = extractDomain(url);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await rateLimitDelay(domain);

    try {
      log.debug(`GET ${url} (attempt ${attempt}/${MAX_RETRIES})`);

      const resp: AxiosResponse<string> = await client.get(url, {
        ...(timeoutMs ? { timeout: timeoutMs } : {}),
      });

      const finalUrl =
        resp.request?.res?.responseUrl ?? resp.config.url ?? url;

      resetBackoff(domain);
      return {
        ok: true,
        response: { status: resp.status, data: resp.data, url, finalUrl },
      };
    } catch (err) {
      const axErr = err as AxiosError;
      const status = axErr.response?.status;
      const code = axErr.code;

      if (status === 403 || status === 429) {
        log.warn(`${url} returned ${status} — entering rate-limit backoff`);
        const canRetry = await handleRateLimitBackoff(domain);
        if (canRetry) {
          attempt--;
          continue;
        }
        return { ok: false, error: { message: `RATE_LIMITED after backoff: ${axErr.message}`, status, code } };
      }

      if (status && status >= 400 && status < 500) {
        log.warn(`${url} returned ${status} — not retrying`);
        return { ok: false, error: { message: axErr.message, status, code } };
      }

      if (attempt < MAX_RETRIES) {
        const backoff = attempt * 2000;
        log.warn(`${url} failed (${code ?? status ?? 'unknown'}) — retrying in ${backoff}ms`);
        await sleep(backoff);
      } else {
        log.error(`${url} failed after ${MAX_RETRIES} attempts: ${axErr.message}`);
        return { ok: false, error: { message: axErr.message, status, code } };
      }
    }
  }

  return { ok: false, error: { message: 'Max retries exceeded' } };
}

// ---------------------------------------------------------------------------
// GET (binary / PDF download)
// ---------------------------------------------------------------------------

export interface BinaryResult {
  ok: true;
  data: Buffer;
  contentType: string;
}

export interface BinaryError {
  ok: false;
  error: HttpError;
}

export type BinaryHttpResult = BinaryResult | BinaryError;

export async function fetchBinary(
  url: string,
  timeoutMs: number = PDF_DOWNLOAD_TIMEOUT_MS,
): Promise<BinaryHttpResult> {
  const domain = extractDomain(url);
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await rateLimitDelay(domain);

    try {
      log.debug(`GET (binary) ${url} (attempt ${attempt}/${maxAttempts})`);
      const resp = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: timeoutMs,
        headers: { 'User-Agent': USER_AGENT },
        maxRedirects: 10,
        validateStatus: (s) => s >= 200 && s < 400,
      });

      const contentType =
        (resp.headers['content-type'] as string | undefined) ?? '';

      resetBackoff(domain);
      return { ok: true, data: Buffer.from(resp.data as ArrayBuffer), contentType };
    } catch (err) {
      const axErr = err as AxiosError;
      const status = axErr.response?.status;
      const code = axErr.code;

      if (status === 403 || status === 429) {
        const canRetry = await handleRateLimitBackoff(domain);
        if (canRetry) {
          attempt--;
          continue;
        }
      }

      const isRetryable =
        !status ||
        status >= 500 ||
        code === 'ECONNABORTED' ||
        code === 'ETIMEDOUT';

      if (isRetryable && attempt < maxAttempts) {
        log.warn(`Binary download failed (${code ?? status}) — retrying in 3s`);
        await sleep(3_000);
        continue;
      }

      log.error(`Binary download failed: ${axErr.message}`);
      return { ok: false, error: { message: axErr.message, status, code } };
    }
  }

  return { ok: false, error: { message: 'Max binary download attempts exceeded' } };
}
