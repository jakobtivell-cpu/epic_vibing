#!/usr/bin/env ts-node
// ---------------------------------------------------------------------------
// CLI entrypoint — run with: npx ts-node scrape.ts [options]
// ---------------------------------------------------------------------------

import { Command } from 'commander';
import * as fs from 'fs';
import {
  DEFAULT_COMPANIES,
  findByTicker,
  loadCustomCompanies,
  DOWNLOADS_DIR,
  OUTPUT_DIR,
  RESULTS_PATH,
  CACHE_DIR,
} from './src/config';
import { CompanyProfile, PipelineResult, RunConfig } from './src/types';
import { createLogger, setLogLevel } from './src/utils';
import { runPipeline } from './src/pipeline';
import { writeResults, mergeResults, writeRunSummary, printRunSummary } from './src/output';

const log = createLogger('cli');

const program = new Command();

program
  .name('scrape')
  .description('Scrape annual report data from Swedish Large Cap companies')
  .version('1.0.0')
  .option('--ticker <ticker>', 'Run for a single company by ticker (e.g. "VOLV B")')
  .option('--force', 'Re-download and reprocess everything, ignoring cache', false)
  .option('--failed', 'Re-run only companies that failed in the last run', false)
  .option(
    '--config <path>',
    'Path to a custom JSON file with company profiles (overrides default registry)',
  )
  .option('--verbose', 'Enable debug-level logging', false);

async function main(): Promise<void> {
  program.parse();
  const opts = program.opts();

  if (opts.verbose) {
    setLogLevel('debug');
  }

  log.info('Swedish Large Cap Annual Report Scraper starting');

  ensureDir(DOWNLOADS_DIR);
  ensureDir(OUTPUT_DIR);
  ensureDir(CACHE_DIR);

  let companies: CompanyProfile[];

  if (opts.config) {
    log.info(`Loading custom company config from ${opts.config}`);
    companies = await loadCustomCompanies(opts.config);
    log.info(`Loaded ${companies.length} companies from custom config`);
  } else {
    companies = DEFAULT_COMPANIES;
    log.info(`Using default registry: ${companies.length} companies`);
  }

  if (opts.ticker) {
    const match = findByTicker(companies, opts.ticker);
    if (!match) {
      log.error(`Ticker "${opts.ticker}" not found in company list`);
      log.info(
        'Available tickers: ' + companies.map((c) => c.ticker).join(', '),
      );
      process.exit(1);
    }
    companies = [match];
    log.info(`Filtered to single company: ${match.name} (${match.ticker})`);
  }

  if (opts.failed) {
    companies = filterToFailed(companies);
    if (companies.length === 0) {
      log.info('No previously failed companies to retry. Exiting.');
      return;
    }
    log.info(`Retrying ${companies.length} previously failed companies`);
  }

  const runConfig: RunConfig = {
    companies,
    force: opts.force,
    failedOnly: opts.failed,
    ticker: opts.ticker,
  };

  log.info('Run config assembled', {
    companyCount: runConfig.companies.length,
    force: runConfig.force,
    failedOnly: runConfig.failedOnly,
  });

  const results = await runPipeline(runConfig.companies, runConfig.force);

  if (opts.ticker) {
    mergeResults(results);
  } else {
    writeResults(results);
  }

  writeRunSummary(results);
  printRunSummary(results);
}

function filterToFailed(companies: CompanyProfile[]): CompanyProfile[] {
  if (!fs.existsSync(RESULTS_PATH)) {
    log.warn('No previous results.json found — cannot filter to failed');
    return companies;
  }

  const raw = fs.readFileSync(RESULTS_PATH, 'utf-8');
  let previous: Array<Record<string, unknown>>;
  try {
    const parsed = JSON.parse(raw);
    previous = Array.isArray(parsed) ? parsed : parsed.results ?? [];
  } catch {
    log.warn('Could not parse previous results.json — running all companies');
    return companies;
  }

  const failedTickers = new Set(
    previous
      .filter((r: Record<string, unknown>) => {
        // New schema: check status field
        if (r.status === 'failed') return true;
        // Old schema compat: check stages
        if (r.stages && typeof r.stages === 'object') {
          return Object.values(r.stages as Record<string, { status: string }>)
            .some((s) => s.status === 'failed');
        }
        return false;
      })
      .map((r) => String(r.ticker ?? '').toUpperCase()),
  );

  return companies.filter((c) => failedTickers.has(c.ticker.toUpperCase()));
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
