// ---------------------------------------------------------------------------
// Run one or more companies in subprocess(es) when --timeout-per-company is set.
// ---------------------------------------------------------------------------

import { fork, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CompanyProfile, PipelineResult } from '../types';
import {
  PROJECT_ROOT,
  TIMEOUT_CHILD_SIGKILL_GRACE_MS,
} from '../config/settings';
import {
  runPipeline,
  type RunPipelineOptions,
  buildTimeoutResult,
  buildFailedResult,
} from '../pipeline';
import { createLogger } from '../utils/logger';

const log = createLogger('child-runner');

interface ChildInput {
  company: CompanyProfile;
  force: boolean;
  options?: RunPipelineOptions;
}

function createPool(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  const schedule = () => {
    if (active >= concurrency) return;
    const next = queue.shift();
    if (!next) return;
    active++;
    next();
  };

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push(async () => {
          try {
            resolve(await task());
          } catch (err) {
            reject(err);
          } finally {
            active--;
            schedule();
          }
        });
        schedule();
      });
    },
  };
}

function normalizeConcurrency(
  requestedConcurrency: number | undefined,
  totalCompanies: number,
): number {
  if (totalCompanies <= 1) return 1;
  const raw = Math.trunc(requestedConcurrency ?? 1);
  if (!Number.isFinite(raw) || raw <= 1) return 1;
  return Math.min(raw, totalCompanies);
}

function resolveChildScript(): { script: string; execArgv: string[] } {
  const tsPath = path.join(PROJECT_ROOT, 'src/cli/run-single-company.ts');
  const jsPath = path.join(PROJECT_ROOT, 'dist/src/cli/run-single-company.js');
  const fromTsEntry =
    typeof __filename === 'string' &&
    (__filename.endsWith('.ts') || __filename.includes(`${path.sep}ts-node`));
  if (fromTsEntry || !fs.existsSync(jsPath)) {
    return {
      script: tsPath,
      execArgv: ['-r', require.resolve('ts-node/register/transpile-only')],
    };
  }
  return { script: jsPath, execArgv: [] };
}

function runSingleCompanyChild(
  company: CompanyProfile,
  force: boolean,
  options: RunPipelineOptions | undefined,
  timeoutMs: number,
): Promise<PipelineResult> {
  return new Promise((resolve) => {
    const { script, execArgv } = resolveChildScript();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scrape-child-'));
    const inputPath = path.join(tmp, 'in.json');
    const outputPath = path.join(tmp, 'out.json');
    const payload: ChildInput = { company, force, options };
    fs.writeFileSync(inputPath, JSON.stringify(payload), 'utf-8');

    const child: ChildProcess = fork(script, [inputPath, outputPath], {
      cwd: PROJECT_ROOT,
      execArgv,
      silent: false,
      env: { ...process.env },
    });

    let finished = false;
    let sigkillTimer: NodeJS.Timeout | undefined;

    const finish = (result: PipelineResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      if (finished) return;
      log.warn(`[${company.name}] SIGTERM after ${timeoutMs}ms (timeout-per-company)`);
      child.kill('SIGTERM');
      sigkillTimer = setTimeout(() => {
        if (finished) return;
        log.warn(`[${company.name}] SIGKILL after grace period`);
        child.kill('SIGKILL');
      }, TIMEOUT_CHILD_SIGKILL_GRACE_MS);
    }, timeoutMs);

    child.on('exit', (code, signal) => {
      if (finished) return;
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        finish(buildTimeoutResult(company, timeoutMs));
        return;
      }
      if (code !== 0) {
        finish(
          buildFailedResult(
            company,
            `Child exited with code ${code ?? 'unknown'}`,
          ),
        );
        return;
      }
      try {
        const raw = fs.readFileSync(outputPath, 'utf-8');
        const parsed = JSON.parse(raw) as PipelineResult;
        finish(parsed);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        finish(buildFailedResult(company, `Child output unreadable: ${msg}`));
      }
    });

    child.on('error', (err) => {
      if (finished) return;
      finish(
        buildFailedResult(
          company,
          err instanceof Error ? err.message : String(err),
        ),
      );
    });
  });
}

export async function runCompaniesWithOptionalChildTimeout(
  companies: CompanyProfile[],
  force: boolean,
  options: RunPipelineOptions | undefined,
  timeoutPerCompanyMs: number | undefined,
  childConcurrency?: number,
): Promise<PipelineResult[]> {
  if (timeoutPerCompanyMs == null || timeoutPerCompanyMs <= 0) {
    return runPipeline(companies, force, options);
  }

  const concurrency = normalizeConcurrency(childConcurrency, companies.length);

  if (concurrency === 1) {
    const results: PipelineResult[] = [];
    for (let i = 0; i < companies.length; i++) {
      const company = companies[i];
      log.info(
        `Processing ${company.name} [${i + 1}/${companies.length}] (subprocess, timeout ${timeoutPerCompanyMs}ms)`,
      );
      try {
        results.push(
          await runSingleCompanyChild(company, force, options, timeoutPerCompanyMs),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`[${company.name}] Fatal: ${message}`);
        results.push(buildFailedResult(company, message));
      }
    }
    return results;
  }

  log.info(
    `Processing ${companies.length} companies with subprocess concurrency ${concurrency} (timeout ${timeoutPerCompanyMs}ms each)`,
  );

  const pool = createPool(concurrency);
  const results: PipelineResult[] = [];
  results.length = companies.length;
  await Promise.all(
    companies.map((company, i) =>
      pool.run(async () => {
        log.info(
          `Processing ${company.name} [${i + 1}/${companies.length}] (subprocess, timeout ${timeoutPerCompanyMs}ms)`,
        );
        try {
          results[i] = await runSingleCompanyChild(
            company,
            force,
            options,
            timeoutPerCompanyMs,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error(`[${company.name}] Fatal: ${message}`);
          results[i] = buildFailedResult(company, message);
        }
      }),
    ),
  );
  return results;
}
