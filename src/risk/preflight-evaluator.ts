import * as fs from 'fs';
import * as path from 'path';

export type PreflightRiskTier = 'low' | 'medium' | 'high';
export type PreflightArchetype =
  | 'js_heavy_ir'
  | 'ambiguous_pdf_corpus'
  | 'layout_fragile_pdf'
  | 'industry_semantic_risk'
  | 'entity_ambiguity'
  | 'cloud_transport_risk';

export interface PreflightRiskRow {
  ticker: string;
  company: string;
  riskScore: number;
  riskTier: PreflightRiskTier;
  confidenceBand: 'high' | 'medium' | 'low';
  archetypes: PreflightArchetype[];
  signals: string[];
  recommendedAction: string;
  latestStatus: 'preflight';
  latestConfidence: number | null;
  evidence: {
    irUrl: string | null;
    finalUrl: string | null;
    statusCode: number | null;
    responseTimeMs: number | null;
    redirectCount: number;
    annualSignalCount: number;
    pdfLikeLinkCount: number;
  };
}

interface TickerMeta {
  ticker: string;
  company: string;
  irPage: string | null;
  candidateDomains: string[];
}

interface PreflightCheck {
  statusCode: number | null;
  finalUrl: string | null;
  responseTimeMs: number | null;
  redirectCount: number;
  html: string;
  error: string | null;
}

function riskTier(score: number): PreflightRiskTier {
  if (score <= 34) return 'low';
  if (score <= 64) return 'medium';
  return 'high';
}

function confidenceBand(signalCount: number): 'high' | 'medium' | 'low' {
  if (signalCount >= 5) return 'high';
  if (signalCount >= 3) return 'medium';
  return 'low';
}

function baseOrigin(url: string): string | null {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return null;
  }
}

function host(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function parseTickerMap(tickerJsonPath: string): TickerMeta[] {
  const raw = fs.readFileSync(tickerJsonPath, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const out: TickerMeta[] = [];
  for (const [ticker, value] of Object.entries(parsed)) {
    if (typeof value === 'string') {
      out.push({ ticker, company: value, irPage: null, candidateDomains: [] });
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    const v = value as {
      name?: unknown;
      irPage?: unknown;
      candidateDomains?: unknown;
    };
    if (typeof v.name !== 'string') continue;
    const domains = Array.isArray(v.candidateDomains)
      ? v.candidateDomains.filter((x): x is string => typeof x === 'string')
      : [];
    out.push({
      ticker,
      company: v.name,
      irPage: typeof v.irPage === 'string' ? v.irPage : null,
      candidateDomains: domains,
    });
  }
  out.sort((a, b) => a.company.localeCompare(b.company, 'sv') || a.ticker.localeCompare(b.ticker, 'sv'));
  return out;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ac.signal,
      headers: {
        'user-agent': 'epic-vibing-preflight/1.0',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function runPreflight(url: string): Promise<PreflightCheck> {
  const start = Date.now();
  try {
    const res = await fetchWithTimeout(url, 7000);
    const text = await res.text();
    const elapsed = Date.now() - start;
    const redirected = res.redirected ? 1 : 0;
    return {
      statusCode: res.status,
      finalUrl: res.url || url,
      responseTimeMs: elapsed,
      redirectCount: redirected,
      html: text.slice(0, 400_000),
      error: null,
    };
  } catch (e) {
    return {
      statusCode: null,
      finalUrl: null,
      responseTimeMs: Date.now() - start,
      redirectCount: 0,
      html: '',
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function evaluateRow(meta: TickerMeta, chk: PreflightCheck): PreflightRiskRow {
  const archetypes = new Set<PreflightArchetype>();
  const signals: string[] = [];
  let score = 0;

  const hay = chk.html.toLowerCase();
  const annualSignals = [
    'annual report',
    'årsredovisning',
    'financial reports',
    'investors',
    'reports',
  ].reduce((acc, s) => acc + (hay.includes(s) ? 1 : 0), 0);
  const pdfLikeLinkCount = (hay.match(/\.pdf(\?|")/g) ?? []).length;
  const scriptCount = (hay.match(/<script[\s>]/g) ?? []).length;
  const anchorCount = (hay.match(/<a[\s>]/g) ?? []).length;

  if (chk.statusCode === null || chk.statusCode >= 400) {
    score += 25;
    signals.push(`IR page unreachable (${chk.statusCode ?? 'network error'}).`);
    archetypes.add('cloud_transport_risk');
  }
  if (chk.responseTimeMs !== null && chk.responseTimeMs > 5000) {
    score += 8;
    signals.push(`Slow IR response (${chk.responseTimeMs} ms).`);
    archetypes.add('cloud_transport_risk');
  }
  if (annualSignals === 0) {
    score += 15;
    signals.push('No annual-report language detected on IR page.');
    archetypes.add('ambiguous_pdf_corpus');
  }
  if (pdfLikeLinkCount === 0) {
    score += 10;
    signals.push('No PDF-like links detected on IR page.');
    archetypes.add('ambiguous_pdf_corpus');
  }

  const finalHost = chk.finalUrl ? host(chk.finalUrl) : null;
  if (finalHost && meta.candidateDomains.length > 0) {
    const matches = meta.candidateDomains.some((d) => {
      const h = d.startsWith('http') ? host(d) : d.toLowerCase().replace(/^www\./, '');
      return Boolean(h && finalHost.includes(h));
    });
    if (!matches) {
      score += 15;
      signals.push(`Final host ${finalHost} does not match candidate domains.`);
      archetypes.add('entity_ambiguity');
    }
  }

  if (scriptCount >= 8 && anchorCount <= 12) {
    score += 15;
    signals.push('Page appears JS-heavy; likely needs Playwright discovery.');
    archetypes.add('js_heavy_ir');
  }
  if (/access denied|forbidden|captcha|cloudflare|bot/i.test(hay)) {
    score += 10;
    signals.push('Potential anti-bot/challenge markers found.');
    archetypes.add('cloud_transport_risk');
  }

  const finalScore = Math.max(0, Math.min(100, score));
  const tier = riskTier(finalScore);
  const tags = [...archetypes].sort();
  let action = 'Low maintenance; include in periodic preflight checks.';
  if (tier === 'medium') {
    action = 'Monitor IR link stability and verify annual report discoverability.';
  } else if (tier === 'high') {
    action = 'Run targeted cloud scrape validation and tune discovery/fallback rules.';
  }

  return {
    ticker: meta.ticker,
    company: meta.company,
    riskScore: finalScore,
    riskTier: tier,
    confidenceBand: confidenceBand(signals.length),
    archetypes: tags,
    signals,
    recommendedAction: action,
    latestStatus: 'preflight',
    latestConfidence: null,
    evidence: {
      irUrl: meta.irPage,
      finalUrl: chk.finalUrl,
      statusCode: chk.statusCode,
      responseTimeMs: chk.responseTimeMs,
      redirectCount: chk.redirectCount,
      annualSignalCount: annualSignals,
      pdfLikeLinkCount,
    },
  };
}

async function runWithConcurrency<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  concurrency: number,
): Promise<void> {
  let idx = 0;
  async function loop(): Promise<void> {
    while (true) {
      const current = idx;
      idx += 1;
      if (current >= items.length) return;
      await worker(items[current]);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => loop()));
}

export async function evaluatePreflightRiskForAll(opts: {
  tickerJsonPath: string;
  outputPath: string;
  concurrency?: number;
}): Promise<{ generatedAt: string; companyCount: number; results: PreflightRiskRow[] }> {
  const rows = parseTickerMap(opts.tickerJsonPath);
  const out: PreflightRiskRow[] = [];
  const c = opts.concurrency ?? 8;

  await runWithConcurrency(
    rows,
    async (meta) => {
      const fallbackUrl =
        meta.irPage ||
        meta.candidateDomains.map((d) => (d.startsWith('http') ? d : `https://${d}`)).find(Boolean) ||
        null;
      if (!fallbackUrl) {
        out.push(
          evaluateRow(meta, {
            statusCode: null,
            finalUrl: null,
            responseTimeMs: null,
            redirectCount: 0,
            html: '',
            error: 'No IR page/candidate domain configured',
          }),
        );
        return;
      }
      const chk = await runPreflight(fallbackUrl);
      out.push(evaluateRow(meta, chk));
    },
    c,
  );

  out.sort(
    (a, b) =>
      b.riskScore - a.riskScore ||
      a.company.localeCompare(b.company, 'sv') ||
      a.ticker.localeCompare(b.ticker, 'sv'),
  );

  const payload = {
    generatedAt: new Date().toISOString(),
    companyCount: out.length,
    results: out,
  };
  fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });
  fs.writeFileSync(opts.outputPath, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

export function loadPreflightRiskFile(outputPath: string): {
  generatedAt: string | null;
  companyCount: number;
  results: PreflightRiskRow[];
} | null {
  if (!fs.existsSync(outputPath)) return null;
  try {
    const raw = fs.readFileSync(outputPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      generatedAt?: string | null;
      companyCount?: number;
      results?: PreflightRiskRow[];
    };
    return {
      generatedAt: parsed.generatedAt ?? null,
      companyCount:
        typeof parsed.companyCount === 'number'
          ? parsed.companyCount
          : Array.isArray(parsed.results)
            ? parsed.results.length
            : 0,
      results: Array.isArray(parsed.results) ? parsed.results : [],
    };
  } catch {
    return null;
  }
}
