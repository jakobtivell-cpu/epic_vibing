/**
 * Monthly IR URL health check (invoked from GitHub Actions).
 * Reads data/ticker.json, HEAD-checks each unique irPage, suggests fixes via Anthropic + web search.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TICKER_PATH = path.join(REPO_ROOT, 'data', 'ticker.json');

const DELAY_MS = 2000;
const HEAD_TIMEOUT_MS = 30_000;
const UA =
  'Mozilla/5.0 (compatible; EpicVibing-IR-Health/1.0; +https://github.com)';

const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';
const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 10,
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function collectIrEntries(tickerData) {
  const byUrl = new Map();
  for (const [ticker, val] of Object.entries(tickerData)) {
    if (!val || typeof val !== 'object') continue;
    const ir = val.irPage;
    if (typeof ir !== 'string' || !/^https?:\/\//i.test(ir.trim())) continue;
    const url = ir.trim();
    const legal = typeof val.name === 'string' ? val.name : ticker;
    if (!byUrl.has(url)) {
      byUrl.set(url, { irPage: url, tickers: [ticker], name: legal });
    } else {
      const row = byUrl.get(url);
      row.tickers.push(ticker);
      if (typeof val.name === 'string' && val.name.length > row.name.length) {
        row.name = val.name;
      }
    }
  }
  return [...byUrl.values()];
}

async function headStatus(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS);
  try {
    let res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: '*/*' },
    });
    if (res.status === 405 || res.status === 501) {
      clearTimeout(t);
      const c2 = new AbortController();
      const t2 = setTimeout(() => c2.abort(), HEAD_TIMEOUT_MS);
      try {
        res = await fetch(url, {
          method: 'GET',
          redirect: 'follow',
          signal: c2.signal,
          headers: {
            'User-Agent': UA,
            Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
            Range: 'bytes=0-0',
          },
        });
      } finally {
        clearTimeout(t2);
      }
    }
    return res.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(t);
  }
}

function extractTextFromMessage(data) {
  const parts = [];
  for (const block of data.content ?? []) {
    if (block.type === 'text' && block.text) parts.push(block.text);
  }
  return parts.join('\n').trim();
}

function extractFirstHttpUrl(text) {
  const m = text.match(/https?:\/\/[^\s\])"'<>]+/i);
  if (!m) return null;
  return m[0].replace(/[.,;)\]]+$/g, '');
}

function normalizeUrlForCompare(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    let p = x.pathname;
    if (p.endsWith('/') && p.length > 1) p = p.slice(0, -1);
    x.pathname = p;
    return x.href.toLowerCase();
  } catch {
    return u.trim().toLowerCase();
  }
}

function isPlausibleHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function anthropicWithWebSearch(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const messages = [{ role: 'user', content: prompt }];
  let last = null;

  for (let turn = 0; turn < 10; turn++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        messages,
        tools: [WEB_SEARCH_TOOL],
      }),
    });

    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`Anthropic HTTP ${res.status}: ${raw.slice(0, 500)}`);
    }

    const data = JSON.parse(raw);
    last = data;

    if (data.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: data.content });
  }

  return last;
}

async function createIssue({ owner, repo, token, title, body }) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title, body }),
    },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GitHub issues API ${res.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

async function main() {
  const raw = fs.readFileSync(TICKER_PATH, 'utf8');
  const tickerData = JSON.parse(raw);
  const entries = collectIrEntries(tickerData);

  console.log(
    `IR health check: ${entries.length} unique irPage URL(s) from data/ticker.json`,
  );

  const unhealthy = [];
  let index = 0;
  for (const row of entries) {
    if (index++ > 0) await sleep(DELAY_MS);
    const status = await headStatus(row.irPage);
    const ok = status === 200;
    console.log(
      `  [${index}/${entries.length}] ${ok ? 'OK ' : 'BAD'} ${status || 'ERR'} — ${row.name} — ${row.irPage}`,
    );
    if (!ok) unhealthy.push({ ...row, httpStatus: status || 'network error' });
  }

  if (unhealthy.length === 0) {
    console.log(
      `\nSummary: all ${entries.length} IR page URL(s) returned HTTP 200 (or acceptable GET fallback). No action needed.`,
    );
    return;
  }

  console.log(`\n${unhealthy.length} broken URL(s); querying Anthropic + web search…`);

  const repoFull = process.env.GITHUB_REPOSITORY || '';
  const [owner, repo] = repoFull.split('/');
  const token = process.env.GITHUB_TOKEN;
  if (!owner || !repo || !token) {
    console.error(
      'Missing GITHUB_REPOSITORY or GITHUB_TOKEN — cannot open issues.',
    );
    process.exitCode = 1;
    return;
  }

  for (const item of unhealthy) {
    const prompt = `Find the current investor relations page URL for ${item.name} listed on Nasdaq Stockholm. Return only the URL, nothing else.`;
    let suggested = null;
    try {
      const msg = await anthropicWithWebSearch(prompt);
      const text = extractTextFromMessage(msg);
      const candidate = extractFirstHttpUrl(text);
      if (candidate && isPlausibleHttpUrl(candidate)) suggested = candidate;
    } catch (e) {
      console.error(`  Anthropic error for ${item.name}:`, e.message);
    }

    const oldNorm = normalizeUrlForCompare(item.irPage);
    const newNorm = suggested ? normalizeUrlForCompare(suggested) : null;
    const isNew =
      suggested && newNorm && newNorm !== oldNorm && isPlausibleHttpUrl(suggested);

    if (!isNew) {
      console.log(
        `  Skip issue for ${item.name}: no distinct replacement URL from model.`,
      );
      continue;
    }

    const title = `IR page broken: ${item.name}`;
    const body = [
      `Automated **IR health check** detected a non-200 response for a configured investor relations URL.`,
      ``,
      `| Field | Value |`,
      `| --- | --- |`,
      `| Company | ${item.name} |`,
      `| Tickers | ${item.tickers.join(', ')} |`,
      `| HTTP status | ${item.httpStatus} |`,
      ``,
      `### Configured URL (broken)`,
      `\`${item.irPage}\``,
      ``,
      `### Suggested URL (Claude + web search)`,
      `\`${suggested}\``,
      ``,
      `_Workflow: \`ir-health-check\` · Model: \`${ANTHROPIC_MODEL}\`_`,
    ].join('\n');

    const issue = await createIssue({ owner, repo, token, title, body });
    console.log(`  Opened issue #${issue.number}: ${title}`);
  }

  console.log(
    `\nDone. Checked ${entries.length} URL(s); ${unhealthy.length} unhealthy; issues opened where a new URL was suggested.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
