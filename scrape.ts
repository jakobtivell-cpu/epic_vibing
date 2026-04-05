#!/usr/bin/env ts-node
// ---------------------------------------------------------------------------
// CLI entrypoint — generic scraper that takes company names or tickers.
//
// Usage:
//   npx ts-node scrape.ts --company "Sandvik"
//   npx ts-node scrape.ts --company "Sandvik,SEB,Hexagon" --force
//   npx ts-node scrape.ts --ticker "VOLV-B.ST"
//   npx ts-node scrape.ts --ticker "ALFA.ST,ESSITY-B.ST,HM-B.ST"   # comma-separated → sequential, merge results.json
//   npx ts-node scrape.ts --ticker "INVE-A.ST,INVE-B.ST"   # same legal name → deduped → 1 run
//   npx ts-node scrape.ts --company "Volvo" --slow
// ---------------------------------------------------------------------------

import { Command } from 'commander';
import * as fs from 'fs';
import {
  DOWNLOADS_DIR,
  OUTPUT_DIR,
  CACHE_DIR,
} from './src/config';
import { CompanyProfile, RunConfig } from './src/types';
import { createLogger, setLogLevel, setSlowMode } from './src/utils';
import {
  loadTickerMap,
  resolveTicker,
  resolveOrgNumber,
  resolveCandidateDomains,
  resolveIrPage,
  resolveIsin,
  resolveIrEmail,
  normalizeTickerForLookup,
} from './src/data/ticker-map';
import { runPipeline } from './src/pipeline';
import { writeResults, mergeResults, writeRunSummary, printRunSummary } from './src/output';

const log = createLogger('cli');

const program = new Command();

program
  .name('scrape')
  .description('Scrape annual report data from any Swedish Large Cap company')
  .version('2.1.0')
  .option(
    '--company <names>',
    'Comma-separated company names (e.g. "Sandvik,SEB,Hexagon")',
  )
  .option(
    '--ticker <tickers>',
    'Comma-separated Nasdaq Stockholm tickers (e.g. "SEB-A.ST,VOLV-B.ST"). Resolved via data/ticker.json.',
  )
  .option('--force', 'Re-download and reprocess everything, ignoring cache', false)
  .option('--slow', 'Set base delay to 8s for all domains (polite mode)', false)
  .option('--verbose', 'Enable debug-level logging', false)
  .option(
    '--llm-challenger',
    'When OPENAI_API_KEY is set, force the LLM challenger pass for PDF extractions (still requires PDF text)',
    false,
  );

async function main(): Promise<void> {
  program.parse();
  const opts = program.opts();

  if (opts.verbose) {
    setLogLevel('debug');
  }

  if (opts.slow) {
    setSlowMode(true);
  }

  log.info('Swedish Large Cap Annual Report Scraper v2.1 — generic engine');

  // Load ticker map (never fails — logs a warning if missing)
  loadTickerMap();

  ensureDir(DOWNLOADS_DIR);
  ensureDir(OUTPUT_DIR);
  ensureDir(CACHE_DIR);

  const companyOpt = typeof opts.company === 'string' ? opts.company.trim() : '';
  const tickerOpt = typeof opts.ticker === 'string' ? opts.ticker.trim() : '';

  const companies = buildCompanyList(opts);

  if (companies.length === 0) {
    log.error('No companies to process. Provide --company or --ticker.');
    process.exit(1);
  }

  const isDefaultLargeCapBatch = companyOpt.length === 0 && tickerOpt.length === 0;
  const runSequential = companies.length > 1 && !isDefaultLargeCapBatch;

  if (runSequential) {
    log.info(
      `Running ${companies.length} companies sequentially (explicit --company / --ticker list)`,
    );
  }

  log.info(`Processing ${companies.length} company/companies: ${companies.map((c) => c.name).join(', ')}`);

  for (const c of companies) {
    const parts = [c.name];
    if (c.ticker) parts.push(`ticker=${c.ticker}`);
    if (c.legalName) parts.push(`legal="${c.legalName}"`);
    log.info(`  → ${parts.join(', ')}`);
  }

  const runConfig: RunConfig = {
    companies,
    force: opts.force,
    slow: opts.slow,
  };

  const results = await runPipeline(runConfig.companies, runConfig.force, {
    sequential: runSequential,
    llmChallengerForce: Boolean(opts.llmChallenger),
  });

  if (companies.length === 1 || !isDefaultLargeCapBatch) {
    mergeResults(results);
  } else {
    writeResults(results);
  }

  writeRunSummary(results);
  printRunSummary(results);
}

const DEFAULT_LARGE_CAP_TICKERS =
  'VOLV-B.ST,ERIC-B.ST,HM-B.ST,ATCO-B.ST,SAND.ST,SEB-A.ST,INVE-B.ST,HEXA-B.ST,ESSITY-B.ST,ALFA.ST';

// ---------------------------------------------------------------------------
// Build the company list from CLI flags, resolving tickers and deduplicating
// ---------------------------------------------------------------------------

function buildCompanyList(opts: Record<string, unknown>): CompanyProfile[] {
  const profiles: CompanyProfile[] = [];

  const companyOpt = typeof opts.company === 'string' ? opts.company.trim() : '';
  const tickerOptRaw = typeof opts.ticker === 'string' ? opts.ticker.trim() : '';

  // --company flag: raw names, no ticker resolution
  if (companyOpt.length > 0) {
    const names = companyOpt
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n.length > 0);

    for (const name of names) {
      profiles.push({ name });
    }
  }

  const tickerSource =
    tickerOptRaw.length > 0 ? tickerOptRaw : companyOpt.length > 0 ? '' : DEFAULT_LARGE_CAP_TICKERS;

  if (tickerSource.length > 0 && tickerOptRaw.length === 0 && companyOpt.length === 0) {
    log.info('No --company/--ticker — using default Large Cap set (10 tickers)');
  }

  // --ticker flag (or default set): resolve each ticker to a legal name
  if (tickerSource.length > 0) {
    const tickers = tickerSource
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    if (tickerOptRaw.length > 0 && tickers.length > 1) {
      log.info(`--ticker: ${tickers.length} symbols → resolve each and queue for sequential run`);
    }

    for (const rawTicker of tickers) {
      const legalName = resolveTicker(rawTicker);
      const canonicalTicker = normalizeTickerForLookup(rawTicker);
      const orgNumber = resolveOrgNumber(rawTicker) ?? undefined;
      const candidateDomains = resolveCandidateDomains(rawTicker) ?? undefined;
      const irPage = resolveIrPage(rawTicker) ?? undefined;
      const isin = resolveIsin(rawTicker) ?? undefined;
      const irEmail = resolveIrEmail(rawTicker) ?? undefined;
      if (legalName) {
        log.info(
          `Ticker ${rawTicker} → "${legalName}" (${canonicalTicker})${orgNumber ? ` org: ${orgNumber}` : ''}${isin ? ` isin: ${isin}` : ''}${candidateDomains?.length ? ` candidateDomains: ${candidateDomains.join(', ')}` : ''}${irPage ? ` irPage: ${irPage}` : ''}${irEmail ? ` irEmail: ${irEmail}` : ''}`,
        );
        profiles.push({
          name: legalName,
          ticker: canonicalTicker,
          legalName,
          orgNumber,
          ...(candidateDomains?.length ? { candidateDomains } : {}),
          ...(irPage ? { irPage } : {}),
          ...(isin ? { isin } : {}),
          ...(irEmail ? { irEmail } : {}),
        });
      } else {
        log.warn(`Ticker ${rawTicker} not found in ticker map — using as company search name`);
        profiles.push({
          name: rawTicker.trim(),
        });
      }
    }
  }

  // Deduplicate by canonical name (legal name or name).
  // Multiple share classes (e.g. INVE-A.ST and INVE-B.ST) resolve to the
  // same legal name — scrape only once.
  const seen = new Map<string, CompanyProfile>();
  for (const p of profiles) {
    const key = (p.legalName ?? p.name).toLowerCase();
    if (seen.has(key)) {
      const existing = seen.get(key)!;
      log.info(`Deduplicating "${p.name}" — same entity as "${existing.name}"`);
      // Keep the first ticker but note the duplicate
      continue;
    }
    seen.set(key, p);
  }

  return [...seen.values()];
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    log.debug(`Created directory: ${dir}`);
  }
}

main().catch((err) => {
  log.error('Fatal error', err);
  process.exit(1);
});
