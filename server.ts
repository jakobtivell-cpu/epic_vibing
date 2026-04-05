/**
 * Express dashboard server: serves the UI, runs scrape jobs, streams logs via SSE.
 */

import * as path from 'path';
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import express, { Request, Response } from 'express';

const LOG_LINE_RE = /^\d{4}-\d{2}-\d{2}T/;
const MAX_CONCURRENT = 3;

const ROOT = path.resolve(__dirname);
const DASHBOARD_HTML = path.join(ROOT, 'app', 'swedish-largecap-dashboard.html');
const RESULTS_JSON = path.join(ROOT, 'output', 'results.json');
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
  status: JobStatus;
  exitCode: number | null;
  logs: string[];
  /** Subscribers receive each new log line after they connect (history replayed separately). */
  lineSubs: Set<(line: string) => void>;
  proc: ChildProcess | null;
}

const jobs = new Map<string, Job>();

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
        if (LOG_LINE_RE.test(line)) onCompleteLine(line);
      }
    },
    flush() {
      if (!buf) return;
      const line = buf.replace(/\r$/, '');
      buf = '';
      if (LOG_LINE_RE.test(line)) onCompleteLine(line);
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
    const exitCode = code === null ? 1 : code;
    job.exitCode = exitCode;
    job.status = exitCode === 0 ? 'done' : 'failed';

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
    status: 'running',
    exitCode: null,
    logs: [],
    lineSubs: new Set(),
    proc: null,
  };

  const argv = ['ts-node', 'scrape.ts'];
  if (args.ticker) {
    argv.push('--ticker', args.ticker);
  } else if (args.company) {
    argv.push('--company', args.company);
  }
  if (args.force) argv.push('--force');

  const proc = spawn('npx', argv, {
    cwd: ROOT,
    env: process.env,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  job.proc = proc;
  attachProcessStreams(job, proc);
  jobs.set(job.id, job);
  return job;
}

function cors(req: express.Request, res: express.Response, next: express.NextFunction): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
    if (!fs.existsSync(RESULTS_JSON)) {
      res.json({ results: [], companyCount: 0, generatedAt: null });
      return;
    }
    const raw = fs.readFileSync(RESULTS_JSON, 'utf8');
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
app.listen(PORT, () => {
  console.log(`Dashboard server http://localhost:${PORT}/`);
});
