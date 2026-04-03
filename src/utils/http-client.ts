// ---------------------------------------------------------------------------
// HTTP client — axios wrapper with retry, timeout, and per-domain rate limiting.
// ---------------------------------------------------------------------------

import axios, { AxiosInstance, AxiosResponse, AxiosError } from 'axios';
import {
  USER_AGENT,
  REQUEST_TIMEOUT_MS,
  MAX_RETRIES,
  SAME_DOMAIN_DELAY_MS,
} from '../config/settings';
import { createLogger } from './logger';

const log = createLogger('http');

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

/** Tracks the last request timestamp per domain for rate limiting. */
const domainTimestamps = new Map<string, number>();

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

async function rateLimitDelay(domain: string): Promise<void> {
  const last = domainTimestamps.get(domain);
  if (last) {
    const elapsed = Date.now() - last;
    const wait = SAME_DOMAIN_DELAY_MS - elapsed;
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

const client: AxiosInstance = axios.create({
  timeout: REQUEST_TIMEOUT_MS,
  headers: { 'User-Agent': USER_AGENT },
  maxRedirects: 5,
  // Accept HTML and text responses; don't parse JSON automatically
  responseType: 'text',
  transformResponse: [(data) => data],
});

export interface HeadResult {
  exists: boolean;
  status?: number;
  contentType?: string;
  finalUrl?: string;
}

/**
 * Lightweight HEAD request to check if a URL exists.
 * No retries — single attempt with rate limiting.
 */
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
      // Accept any 2xx/3xx without throwing
      validateStatus: (s) => s < 400,
    });

    const contentType =
      (resp.headers['content-type'] as string | undefined) ?? '';
    const finalUrl =
      resp.request?.res?.responseUrl ?? resp.config.url ?? url;

    return {
      exists: true,
      status: resp.status,
      contentType,
      finalUrl,
    };
  } catch (err) {
    const axErr = err as AxiosError;
    return {
      exists: false,
      status: axErr.response?.status,
    };
  }
}

/**
 * Fetch a URL with retry logic and rate limiting.
 * Never throws — always returns a structured HttpResult.
 */
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

      return {
        ok: true,
        response: {
          status: resp.status,
          data: resp.data,
          url,
          finalUrl,
        },
      };
    } catch (err) {
      const axErr = err as AxiosError;
      const status = axErr.response?.status;
      const code = axErr.code;

      // Don't retry 4xx errors (except 429 Too Many Requests)
      if (status && status >= 400 && status < 500 && status !== 429) {
        log.warn(`${url} returned ${status} — not retrying`);
        return {
          ok: false,
          error: { message: axErr.message, status, code },
        };
      }

      if (attempt < MAX_RETRIES) {
        const backoff = attempt * 2000;
        log.warn(
          `${url} failed (${code ?? status ?? 'unknown'}) — retrying in ${backoff}ms`,
        );
        await sleep(backoff);
      } else {
        log.error(
          `${url} failed after ${MAX_RETRIES} attempts: ${axErr.message}`,
        );
        return {
          ok: false,
          error: { message: axErr.message, status, code },
        };
      }
    }
  }

  // Unreachable, but satisfies the type checker
  return { ok: false, error: { message: 'Max retries exceeded' } };
}

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

/**
 * Download binary content (e.g. PDF) with rate limiting.
 * Single attempt — no retries, since large files are expensive to re-fetch.
 * Uses a longer timeout than fetchPage.
 */
export async function fetchBinary(
  url: string,
  timeoutMs: number = REQUEST_TIMEOUT_MS * 2,
): Promise<BinaryHttpResult> {
  const domain = extractDomain(url);
  await rateLimitDelay(domain);

  try {
    log.debug(`GET (binary) ${url}`);
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: timeoutMs,
      headers: { 'User-Agent': USER_AGENT },
      maxRedirects: 5,
    });

    const contentType =
      (resp.headers['content-type'] as string | undefined) ?? '';

    return {
      ok: true,
      data: Buffer.from(resp.data as ArrayBuffer),
      contentType,
    };
  } catch (err) {
    const axErr = err as AxiosError;
    log.error(`Binary download failed: ${axErr.message}`);
    return {
      ok: false,
      error: {
        message: axErr.message,
        status: axErr.response?.status,
        code: axErr.code,
      },
    };
  }
}
