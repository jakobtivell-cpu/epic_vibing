// ---------------------------------------------------------------------------
// HTTP client — axios wrapper with retry, timeout, per-domain rate limiting,
// randomized delays, exponential backoff on 403/429, configurable slow mode,
// and automatic Playwright transport for hosts that block Axios on first hit.
// ---------------------------------------------------------------------------

import axios, { AxiosInstance, AxiosResponse, AxiosError } from 'axios';
import {
  REQUEST_TIMEOUT_MS,
  PDF_DOWNLOAD_TIMEOUT_MS,
  MAX_RETRIES,
  RATE_LIMIT_BACKOFF_SEQUENCE,
} from '../config/settings';
import { createLogger } from './logger';

const log = createLogger('http');

// ---------------------------------------------------------------------------
// Browser fingerprint — rotate UA per host; stable within a process per domain
// ---------------------------------------------------------------------------

/** Realistic desktop browser User-Agent strings (Chrome / Firefox / Safari; Win / macOS / Linux). */
const BROWSER_USER_AGENTS: readonly string[] = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
];

/** Default headers sent on outbound requests (HTML/HEAD); PDF downloads override Accept. */
const DEFAULT_BROWSER_HEADERS: Readonly<Record<string, string>> = {
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,sv;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  Connection: 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
};

const PDF_ACCEPT =
  'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8';

/** Canonical host key (no leading www, lowercase) for per-host state. */
function normalizeHostKey(hostname: string): string {
  return hostname.replace(/^www\./i, '').toLowerCase();
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

function hostKeyFromUrl(url: string): string {
  return normalizeHostKey(extractDomain(url));
}

/** One chosen User-Agent per host key for the lifetime of the process. */
const userAgentByHost = new Map<string, string>();

/** Last successful document URL per host — used as Referer for follow-up requests on the same host. */
const lastDocumentUrlByHost = new Map<string, string>();

/** Hosts where Axios got HTTP 403 as the first completed response — use Playwright for all further HTTP. */
const hostsRequiringBrowser = new Set<string>();

/**
 * Count of completed Axios HTTP responses (any status) per host.
 * Used to detect "first response was 403" without counting network errors.
 */
const axiosHttpResponseCountByHost = new Map<string, number>();

/** @public For pipeline logging / diagnostics — host key without www, lowercase. */
export function isHostBrowserMode(hostKey: string): boolean {
  return hostsRequiringBrowser.has(normalizeHostKey(hostKey));
}

function markHostRequiresBrowser(hostKey: string): void {
  if (hostsRequiringBrowser.has(hostKey)) return;
  hostsRequiringBrowser.add(hostKey);
  log.info(
    `HTTP client: host "${hostKey}" returned 403 on first Axios response — using Playwright for this host`,
  );
}

function axiosResponseCount(hostKey: string): number {
  return axiosHttpResponseCountByHost.get(hostKey) ?? 0;
}

function recordAxiosHttpResponse(hostKey: string): void {
  axiosHttpResponseCountByHost.set(hostKey, axiosResponseCount(hostKey) + 1);
}

function pickUserAgentForHost(hostKey: string): string {
  let ua = userAgentByHost.get(hostKey);
  if (!ua) {
    const i = Math.floor(Math.random() * BROWSER_USER_AGENTS.length);
    ua = BROWSER_USER_AGENTS[i]!;
    userAgentByHost.set(hostKey, ua);
    log.debug(`HTTP client: selected User-Agent for ${hostKey}: ${ua}`);
  }
  return ua;
}

function mergeBrowserHeaders(
  hostKey: string,
  extra: Record<string, string | undefined>,
): Record<string, string> {
  const ua = pickUserAgentForHost(hostKey);
  const out: Record<string, string> = {
    ...DEFAULT_BROWSER_HEADERS,
    'User-Agent': ua,
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function htmlHeaders(hostKey: string): Record<string, string> {
  const referer = lastDocumentUrlByHost.get(hostKey);
  return mergeBrowserHeaders(hostKey, referer ? { Referer: referer } : {});
}

function binaryHeaders(hostKey: string, url: string): Record<string, string> {
  let referer = lastDocumentUrlByHost.get(hostKey);
  if (!referer) {
    try {
      referer = `${new URL(url).origin}/`;
    } catch {
      referer = 'https://www.google.com/';
    }
  }
  return mergeBrowserHeaders(hostKey, {
    Accept: PDF_ACCEPT,
    Referer: referer,
  });
}

function rememberDocumentUrl(hostKey: string, finalUrl: string, contentType?: string): void {
  if (contentType && /application\/pdf/i.test(contentType)) return;
  lastDocumentUrlByHost.set(hostKey, finalUrl);
}

// ---------------------------------------------------------------------------
// Playwright (lazy singleton) — optional dependency
// ---------------------------------------------------------------------------

let playwrightBrowser: any = null;
let playwrightImportFailed = false;

async function getPlaywrightBrowser(): Promise<any> {
  if (playwrightImportFailed) return null;
  if (playwrightBrowser) return playwrightBrowser;
  try {
    // @ts-ignore — playwright is an optional dependency
    const pw = await import('playwright');
    const chromium = pw.chromium;
    try {
      playwrightBrowser = await chromium.launch({ channel: 'chrome', headless: true });
    } catch {
      playwrightBrowser = await chromium.launch({ headless: true });
    }
    return playwrightBrowser;
  } catch {
    playwrightImportFailed = true;
    log.warn('HTTP client: Playwright not available — browser-mode hosts cannot be fetched');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Slow-mode toggle (set via CLI --slow flag)
// ---------------------------------------------------------------------------

let slowMode = false;

export function setSlowMode(enabled: boolean): void {
  slowMode = enabled;
  log.info(
    `Slow mode ${enabled ? 'enabled' : 'disabled'} — inter-request delay ~${enabled ? '3000–8000' : '800–3000'}ms (plus ~5% chance of +5–15s)`,
  );
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
// Per-domain rate limiting — randomized delays
// ---------------------------------------------------------------------------

const domainTimestamps = new Map<string, number>();
const domainBackoffIndex = new Map<string, number>();

function randomIntInclusive(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function computeInterRequestDelayMs(): number {
  const baseMin = slowMode ? 3000 : 800;
  const baseMax = slowMode ? 8000 : 3000;
  let delay = randomIntInclusive(baseMin, baseMax);
  if (Math.random() < 0.05) {
    delay += randomIntInclusive(5000, 15_000);
  }
  return delay;
}

async function rateLimitDelay(hostKey: string): Promise<void> {
  const last = domainTimestamps.get(hostKey);
  if (last) {
    const elapsed = Date.now() - last;
    const delay = computeInterRequestDelayMs();
    const wait = delay - elapsed;
    if (wait > 0) {
      log.debug(`Rate limiting: waiting ${wait}ms for ${hostKey}`);
      await sleep(wait);
    }
  }
  domainTimestamps.set(hostKey, Date.now());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Exponential backoff for 403/429 (after first-response browser handoff for 403)
// ---------------------------------------------------------------------------

async function handleRateLimitBackoff(hostKey: string): Promise<boolean> {
  const idx = domainBackoffIndex.get(hostKey) ?? 0;
  if (idx >= RATE_LIMIT_BACKOFF_SEQUENCE.length) {
    log.error(`RATE_LIMITED: all backoff retries exhausted for ${hostKey}`);
    return false;
  }
  const delay = RATE_LIMIT_BACKOFF_SEQUENCE[idx];
  log.warn(`RATE_LIMITED: ${hostKey} — backing off ${delay / 1000}s (attempt ${idx + 1}/${RATE_LIMIT_BACKOFF_SEQUENCE.length})`);
  domainBackoffIndex.set(hostKey, idx + 1);
  await sleep(delay);
  domainTimestamps.set(hostKey, Date.now());
  return true;
}

function resetBackoff(hostKey: string): void {
  if (domainBackoffIndex.has(hostKey)) {
    domainBackoffIndex.delete(hostKey);
  }
}

// ---------------------------------------------------------------------------
// Shared axios instance
// ---------------------------------------------------------------------------

const client: AxiosInstance = axios.create({
  timeout: REQUEST_TIMEOUT_MS,
  maxRedirects: 5,
  responseType: 'text',
  transformResponse: [(data) => data],
});

// ---------------------------------------------------------------------------
// Playwright fetch implementations
// ---------------------------------------------------------------------------

async function fetchPageViaPlaywright(
  url: string,
  timeoutMs: number,
): Promise<HttpResult> {
  const hostKey = hostKeyFromUrl(url);
  const browser = await getPlaywrightBrowser();
  if (!browser) {
    return {
      ok: false,
      error: { message: 'Playwright not installed — cannot fetch browser-mode host' },
    };
  }

  await rateLimitDelay(hostKey);
  log.debug(`GET (Playwright) ${url}`);

  const context = await browser.newContext({
    userAgent: pickUserAgentForHost(hostKey),
    extraHTTPHeaders: { ...DEFAULT_BROWSER_HEADERS },
  });

  try {
    const page = await context.newPage();
    let resp: { status: () => number; headers: () => Record<string, string> } | null;
    try {
      resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    } catch {
      await page.close();
      return { ok: false, error: { message: 'Playwright: navigation failed' } };
    }

    if (!resp) {
      await page.close();
      return { ok: false, error: { message: 'Playwright: no response' } };
    }

    const status = resp.status();
    const finalUrl = page.url();
    const ct = (resp.headers()['content-type'] as string | undefined) ?? '';

    if (status >= 400) {
      await page.close();
      return { ok: false, error: { message: `HTTP ${status}`, status } };
    }

    const html = await page.content();
    await page.close();

    rememberDocumentUrl(hostKey, finalUrl, ct);
    resetBackoff(hostKey);
    return {
      ok: true,
      response: { status, data: html, url, finalUrl },
    };
  } finally {
    await context.close();
  }
}

async function headCheckViaPlaywright(
  url: string,
  timeoutMs: number,
): Promise<HeadResult> {
  const hostKey = hostKeyFromUrl(url);
  const browser = await getPlaywrightBrowser();
  if (!browser) {
    return { exists: false };
  }

  await rateLimitDelay(hostKey);
  log.debug(`HEAD (Playwright) ${url}`);

  const context = await browser.newContext({
    userAgent: pickUserAgentForHost(hostKey),
    extraHTTPHeaders: { ...DEFAULT_BROWSER_HEADERS },
  });

  try {
    const req = context.request;
    const resp = await req.head(url, { timeout: timeoutMs });
    const status = resp.status();
    const contentType = (resp.headers()['content-type'] as string | undefined) ?? '';
    const finalUrl = resp.url();

    if (status >= 400) {
      return { exists: false, status };
    }

    if (!/application\/pdf/i.test(contentType)) {
      rememberDocumentUrl(hostKey, finalUrl, contentType);
    }
    resetBackoff(hostKey);
    return { exists: true, status, contentType, finalUrl };
  } catch {
    return { exists: false };
  } finally {
    await context.close();
  }
}

async function fetchBinaryViaPlaywright(
  url: string,
  timeoutMs: number,
): Promise<BinaryHttpResult> {
  const hostKey = hostKeyFromUrl(url);
  const browser = await getPlaywrightBrowser();
  if (!browser) {
    return { ok: false, error: { message: 'Playwright not installed — cannot download from browser-mode host' } };
  }

  await rateLimitDelay(hostKey);
  log.debug(`GET (binary, Playwright) ${url}`);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(binaryHeaders(hostKey, url))) {
    headers[k] = v;
  }

  const context = await browser.newContext({
    userAgent: pickUserAgentForHost(hostKey),
    extraHTTPHeaders: headers,
  });

  try {
    const resp = await context.request.get(url, { timeout: timeoutMs, maxRedirects: 10 });
    const status = resp.status();
    if (status >= 400) {
      return { ok: false, error: { message: `HTTP ${status}`, status } };
    }
    const contentType = (resp.headers()['content-type'] as string | undefined) ?? '';
    const data = await resp.body();
    resetBackoff(hostKey);
    return { ok: true, data: Buffer.from(data), contentType };
  } catch (err) {
    const axErr = err as AxiosError;
    return {
      ok: false,
      error: { message: axErr.message, code: axErr.code },
    };
  } finally {
    await context.close();
  }
}

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
  const hostKey = hostKeyFromUrl(url);

  if (hostsRequiringBrowser.has(hostKey)) {
    return headCheckViaPlaywright(url, timeoutMs);
  }

  await rateLimitDelay(hostKey);

  try {
    log.debug(`HEAD ${url}`);
    const resp = await client.head(url, {
      timeout: timeoutMs,
      validateStatus: (s) => s < 400,
      headers: htmlHeaders(hostKey),
    });

    const contentType =
      (resp.headers['content-type'] as string | undefined) ?? '';
    const finalUrl =
      resp.request?.res?.responseUrl ?? resp.config.url ?? url;

    recordAxiosHttpResponse(hostKey);
    if (!/application\/pdf/i.test(contentType)) {
      rememberDocumentUrl(hostKey, finalUrl, contentType);
    }
    resetBackoff(hostKey);
    return { exists: true, status: resp.status, contentType, finalUrl };
  } catch (err) {
    const axErr = err as AxiosError;
    const status = axErr.response?.status;

    if (status === 403 && axiosResponseCount(hostKey) === 0) {
      markHostRequiresBrowser(hostKey);
      recordAxiosHttpResponse(hostKey);
      return headCheckViaPlaywright(url, timeoutMs);
    }

    if (status !== undefined) {
      recordAxiosHttpResponse(hostKey);
    }

    if (status === 403 || status === 429) {
      const canRetry = await handleRateLimitBackoff(hostKey);
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
  const hostKey = hostKeyFromUrl(url);
  const t = timeoutMs ?? REQUEST_TIMEOUT_MS;

  if (hostsRequiringBrowser.has(hostKey)) {
    return fetchPageViaPlaywright(url, t);
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await rateLimitDelay(hostKey);

    try {
      log.debug(`GET ${url} (attempt ${attempt}/${MAX_RETRIES})`);

      const resp: AxiosResponse<string> = await client.get(url, {
        ...(timeoutMs ? { timeout: timeoutMs } : {}),
        headers: htmlHeaders(hostKey),
      });

      const finalUrl =
        resp.request?.res?.responseUrl ?? resp.config.url ?? url;

      const ct = (resp.headers['content-type'] as string | undefined) ?? '';
      recordAxiosHttpResponse(hostKey);
      rememberDocumentUrl(hostKey, finalUrl, ct);
      resetBackoff(hostKey);
      return {
        ok: true,
        response: { status: resp.status, data: resp.data, url, finalUrl },
      };
    } catch (err) {
      const axErr = err as AxiosError;
      const status = axErr.response?.status;
      const code = axErr.code;

      if (status === 403 && axiosResponseCount(hostKey) === 0) {
        markHostRequiresBrowser(hostKey);
        recordAxiosHttpResponse(hostKey);
        return fetchPageViaPlaywright(url, t);
      }

      if (status !== undefined) {
        recordAxiosHttpResponse(hostKey);
      }

      if (status === 403 || status === 429) {
        log.warn(`${url} returned ${status} — entering rate-limit backoff`);
        const canRetry = await handleRateLimitBackoff(hostKey);
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
  const hostKey = hostKeyFromUrl(url);
  const maxAttempts = 4;

  if (hostsRequiringBrowser.has(hostKey)) {
    return fetchBinaryViaPlaywright(url, timeoutMs);
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await rateLimitDelay(hostKey);

    try {
      log.debug(`GET (binary) ${url} (attempt ${attempt}/${maxAttempts})`);
      const resp = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: timeoutMs,
        headers: binaryHeaders(hostKey, url),
        maxRedirects: 10,
        validateStatus: (s) => s >= 200 && s < 400,
      });

      const contentType =
        (resp.headers['content-type'] as string | undefined) ?? '';

      recordAxiosHttpResponse(hostKey);
      resetBackoff(hostKey);
      return { ok: true, data: Buffer.from(resp.data as ArrayBuffer), contentType };
    } catch (err) {
      const axErr = err as AxiosError;
      const status = axErr.response?.status;
      const code = axErr.code;

      if (status === 403 && axiosResponseCount(hostKey) === 0) {
        markHostRequiresBrowser(hostKey);
        recordAxiosHttpResponse(hostKey);
        return fetchBinaryViaPlaywright(url, timeoutMs);
      }

      if (status !== undefined) {
        recordAxiosHttpResponse(hostKey);
      }

      if (status === 403 || status === 429) {
        const canRetry = await handleRateLimitBackoff(hostKey);
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
