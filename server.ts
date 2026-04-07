/**
 * Express dashboard server: serves the UI, runs scrape jobs, streams logs via SSE.
 */

import * as path from 'path';
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import express, { Request, Response } from 'express';
import { RESULTS_PATH } from './src/config/settings';

const LOG_LINE_RE = /^\d{4}-\d{2}-\d{2}T/;
const MAX_CONCURRENT = 3;
const MAX_JOBS_IN_MEMORY = 50;
const JOB_TTL_MS = 2 * 60 * 60 * 1000;

/** Project root: `server.ts` lives at repo root; compiled `dist/server.js` must resolve one level up. */
const ROOT = path.resolve(__dirname, path.basename(__dirname) === 'dist' ? '..' : '.');
const DASHBOARD_HTML = path.join(ROOT, 'app', 'swedish-largecap-dashboard.html');
const TICKER_JSON = path.join(ROOT, 'data', 'ticker.json');

interface CompanyRow {
  name: string;
  ticker: string;
}

function loadCompaniesFromTickerFile(): CompanyRow[] {
  const raw = fs.readFileSync(TICKER_JSON, 'utf8');
  const data = JSON.parse(raw) as Record<string, unknown>;
  const out: CompanyRow[] = [];
  for (const [ticker, val] of Object.entries(data)) {
    let name: string | undefined;
    if (typeof val === 'string') {
      name = val;
    } else if (val && typeof val === 'object' && typeof (val as { name?: unknown }).name === 'string') {
      name = (val as { name: string }).name;
    }
    if (name) {
      out.push({ name, ticker });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || a.ticker.localeCompare(b.ticker));
  return out;
}

type JobStatus = 'running' | 'done' | 'failed';

interface Job {
  id: string;
  /** When the job row was created (used only for map eviction). */
  createdAt: number;
  status: JobStatus;
  exitCode: number | null;
  /** Set before SIGTERM so `close` reports exitCode -1 for DELETE /api/scrape/:jobId */
  cancelRequested?: boolean;
  logs: string[];
  /** Subscribers receive each new log line after they connect (history replayed separately). */
  lineSubs: Set<(line: string) => void>;
  proc: ChildProcess | null;
}

const jobs = new Map<string, Job>();

/** Drop TTL-expired rows, then oldest rows until there is room for one new job (max MAX_JOBS_IN_MEMORY). */
function evictJobsBeforeInsert(): void {
  const now = Date.now();
  const cutoff = now - JOB_TTL_MS;
  for (const [id, j] of [...jobs.entries()]) {
    if (j.createdAt < cutoff) {
      jobs.delete(id);
    }
  }
  if (jobs.size < MAX_JOBS_IN_MEMORY) {
    return;
  }
  const entries = [...jobs.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
  const targetBeforeAdd = MAX_JOBS_IN_MEMORY - 1;
  let i = 0;
  while (jobs.size > targetBeforeAdd && i < entries.length) {
    jobs.delete(entries[i][0]);
    i++;
  }
}

function runningCount(): number {
  let n = 0;
  for (const j of jobs.values()) {
    if (j.status === 'running') n++;
  }
  return n;
}

function newJobId(): string {
  return `job_${Date.now()}_${randomBytes(4).toString('hex')}`;
}

function appendLogLine(job: Job, line: string): void {
  job.logs.push(line);
  for (const cb of job.lineSubs) {
    try {
      cb(line);
    } catch {
      /* ignore */
    }
  }
}

function createLineSplitter(
  onCompleteLine: (line: string) => void,
): { push: (chunk: Buffer) => void; flush: () => void } {
  let buf = '';
  return {
    push(chunk: Buffer) {
      buf += chunk.toString('utf8');
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.replace(/\r$/, '');
        if (line.length === 0) continue;
        onCompleteLine(LOG_LINE_RE.test(line) ? line : `[raw] ${line}`);
      }
    },
    flush() {
      if (!buf) return;
      const line = buf.replace(/\r$/, '');
      buf = '';
      if (line.length === 0) return;
      onCompleteLine(LOG_LINE_RE.test(line) ? line : `[raw] ${line}`);
    },
  };
}

function attachProcessStreams(job: Job, proc: ChildProcess): void {
  const out = createLineSplitter((line) => appendLogLine(job, line));
  const err = createLineSplitter((line) => appendLogLine(job, line));

  proc.stdout?.on('data', (c: Buffer) => out.push(c));
  proc.stderr?.on('data', (c: Buffer) => err.push(c));

  proc.on('close', (code) => {
    out.flush();
    err.flush();

    job.proc = null;
    let exitCode: number;
    if (job.cancelRequested) {
      exitCode = -1;
      job.exitCode = -1;
      job.status = 'failed';
    } else {
      exitCode = code === null ? 1 : code;
      job.exitCode = exitCode;
      job.status = exitCode === 0 ? 'done' : 'failed';
    }

    const donePayload = JSON.stringify({ type: 'done', exitCode });
    for (const cb of [...job.lineSubs]) {
      try {
        cb(`__DONE__${donePayload}`);
      } catch {
        /* ignore */
      }
    }
  });

  proc.on('error', () => {
    job.proc = null;
    job.exitCode = 1;
    job.status = 'failed';
    const donePayload = JSON.stringify({ type: 'done', exitCode: 1 });
    for (const cb of [...job.lineSubs]) {
      try {
        cb(`__DONE__${donePayload}`);
      } catch {
        /* ignore */
      }
    }
  });
}

function spawnScrape(args: { ticker?: string; company?: string; force?: boolean }): Job {
  const job: Job = {
    id: newJobId(),
    createdAt: Date.now(),
    status: 'running',
    exitCode: null,
    logs: [],
    lineSubs: new Set(),
    proc: null,
  };

  const argv = ['dist/scrape.js'];
  if (args.ticker) {
    argv.push('--ticker', args.ticker);
  } else if (args.company) {
    argv.push('--company', args.company);
  }
  if (args.force) argv.push('--force');

  const proc = spawn('node', argv, {
    cwd: ROOT,
    env: process.env,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  job.proc = proc;
  attachProcessStreams(job, proc);
  evictJobsBeforeInsert();
  jobs.set(job.id, job);
  return job;
}

function cors(req: express.Request, res: express.Response, next: express.NextFunction): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
}

function sseInit(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  (res as Response & { flushHeaders?: () => void }).flushHeaders?.();
}

const app = express();
app.use(cors);
app.use(express.json({ limit: '32kb' }));

app.get('/', (_req: Request, res: Response) => {
  res.sendFile(DASHBOARD_HTML);
});

app.get('/api/companies', (_req: Request, res: Response) => {
  try {
    if (!fs.existsSync(TICKER_JSON)) {
      res.json([]);
      return;
    }
    res.json(loadCompaniesFromTickerFile());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg });
  }
});

app.post('/api/scrape', (req: Request, res: Response) => {
  const body = req.body as { ticker?: string; company?: string; force?: boolean };
  const ticker = typeof body.ticker === 'string' ? body.ticker.trim() : '';
  const company = typeof body.company === 'string' ? body.company.trim() : '';
  const force = Boolean(body.force);

  if ((!ticker && !company) || (ticker && company)) {
    res.status(400).json({ error: 'Provide exactly one of ticker or company' });
    return;
  }

  if (runningCount() >= MAX_CONCURRENT) {
    res.status(429).json({
      error: `Too many concurrent scrape jobs (max ${MAX_CONCURRENT}). Wait for one to finish.`,
    });
    return;
  }

  try {
    const job = spawnScrape(
      ticker ? { ticker, force } : { company: company!, force },
    );
    res.json({ jobId: job.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg });
  }
});

app.delete('/api/scrape/:jobId', (req: Request, res: Response) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  if (job.status !== 'running') {
    res.status(400).json({ error: 'Job is not running' });
    return;
  }
  job.cancelRequested = true;
  if (job.proc) {
    job.proc.kill('SIGTERM');
  } else {
    job.exitCode = -1;
    job.status = 'failed';
    const donePayload = JSON.stringify({ type: 'done', exitCode: -1 });
    for (const cb of [...job.lineSubs]) {
      try {
        cb(`__DONE__${donePayload}`);
      } catch {
        /* ignore */
      }
    }
  }
  res.json({ cancelled: true });
});

app.get('/api/stream/:jobId', (req: Request, res: Response) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  sseInit(res);

  const send = (obj: unknown) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  for (const line of job.logs) {
    send({ type: 'log', line });
  }

  if (job.status !== 'running') {
    send({ type: 'done', exitCode: job.exitCode ?? 1 });
    res.end();
    return;
  }

  const onLine = (payload: string) => {
    if (payload.startsWith('__DONE__')) {
      const json = payload.slice('__DONE__'.length);
      try {
        const parsed = JSON.parse(json) as { type: string; exitCode: number };
        send(parsed);
      } catch {
        send({ type: 'done', exitCode: 1 });
      }
      cleanup();
      res.end();
      return;
    }
    send({ type: 'log', line: payload });
  };

  const cleanup = () => {
    job.lineSubs.delete(onLine);
    req.off('close', cleanup);
  };

  job.lineSubs.add(onLine);

  if (job.status !== 'running') {
    job.lineSubs.delete(onLine);
    send({ type: 'done', exitCode: job.exitCode ?? 1 });
    res.end();
    return;
  }

  req.on('close', cleanup);
});

app.get('/api/results', (_req: Request, res: Response) => {
  try {
    if (!fs.existsSync(RESULTS_PATH)) {
      res.json({ results: [], companyCount: 0, generatedAt: null });
      return;
    }
    const raw = fs.readFileSync(RESULTS_PATH, 'utf8');
    const data = JSON.parse(raw) as {
      results?: unknown[];
      companyCount?: number;
      generatedAt?: string;
    };
    const results = Array.isArray(data.results) ? data.results : [];
    res.json({
      results,
      companyCount: typeof data.companyCount === 'number' ? data.companyCount : results.length,
      generatedAt: data.generatedAt ?? null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg });
  }
});

app.delete('/api/results', (_req: Request, res: Response) => {
  try {
    const empty = { generatedAt: null, companyCount: 0, results: [] as unknown[] };
    fs.mkdirSync(path.dirname(RESULTS_PATH), { recursive: true });
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(empty, null, 2), 'utf8');
    res.json({ cleared: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/status/:jobId', (req: Request, res: Response) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  const payload: {
    status: JobStatus;
    exitCode?: number;
  } = { status: job.status };
  if (job.exitCode !== null) payload.exitCode = job.exitCode;
  res.json(payload);
});

const PORT = Number(process.env.PORT) || 3000;
function ensurePlaywrightChromiumInstalled(): void {
  try {
    // @ts-ignore — playwright is an optional dependency
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pw = require('playwright');
    const chromium = pw?.chromium as { executablePath: () => string } | undefined;
    if (!chromium) {
      console.info('[INFO] Playwright chromium API unavailable — skipping startup browser install');
      return;
    }

    const beforePath = chromium.executablePath();
    const hadBinary = Boolean(beforePath && fs.existsSync(beforePath));
    const cliPath = path.join(ROOT, 'node_modules', 'playwright', 'cli.js');
    if (!fs.existsSync(cliPath)) {
      console.info(
        `[INFO] Playwright startup install skipped: CLI not found at ${cliPath} (system deps not installed)`,
      );
      return;
    }

    console.info(
      `[INFO] Running "node node_modules/playwright/cli.js install chromium --with-deps" at startup (browser already present: ${hadBinary ? 'yes' : 'no'}${hadBinary ? ` at ${beforePath}` : ''})`,
    );
    const install = spawnSync(
      process.execPath,
      [cliPath, 'install', 'chromium', '--with-deps'],
      {
        cwd: ROOT,
        env: process.env,
        shell: false,
        stdio: 'pipe',
        encoding: 'utf8',
      },
    );

    if (install.status === 0) {
      const afterPath = chromium.executablePath();
      console.info(
        `[INFO] Playwright startup install succeeded; Chromium + system deps installed (executablePath: ${afterPath})`,
      );
    } else {
      const details = (install.stderr || install.stdout || '').toString().trim();
      console.info(
        `[INFO] Playwright startup install failed (system deps not installed) (exit ${install.status ?? 'null'})${details ? `: ${details}` : ''}`,
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.info(`[INFO] Playwright startup check skipped: ${msg}`);
  }
}

ensurePlaywrightChromiumInstalled();
app.listen(PORT, () => {
  console.log(`Dashboard server http://localhost:${PORT}/`);
});
