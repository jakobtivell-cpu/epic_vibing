# Swedish Large Cap Annual Report Scraper

**Version 2.1.0** — Node.js + TypeScript pipeline that discovers investor-relations pages, downloads annual report PDFs, extracts key figures with deterministic heuristics, validates plausibility, and writes `output/results.json`. The core scraper uses **public websites only** (no API keys required). Optional **OpenAI** integration runs an LLM “challenger” pass when configured; the **IR health-check** script uses **Anthropic** (see [Environment](#environment)).

## What works today

- **End-to-end pipeline** for arbitrary Swedish Large Cap names (`--company`) or Nasdaq Stockholm tickers (`--ticker`), resolved through `data/ticker.json`.
- **Verified `irPage` URLs** in `ticker.json` skip brittle IR discovery for those rows.
- **Cheerio-first HTML**, **pdf-parse** for text, optional **Playwright** for JS-rendered IR pages (install Chromium when needed: `npx playwright install chromium`).
- **Per-host User-Agent rotation**, retries, and backoff in `src/utils/http-client.ts`.
- **Entity-aware PDF checks**, URL normalization (encoded quotes, double slashes), fused-year and unit guards in extraction, type-aware validation (industrial / bank / investment company).
- **Merge-safe reruns**: processing one ticker updates that company’s row in `results.json` by matching **`company` name** (case-insensitive), leaving other rows unchanged.
- **Express dashboard** (`npm run server`): static UI, API for results, scrape jobs with log streaming (see [Dashboard](#dashboard)).

## What is partial or fragile

- **Row quality varies by issuer**: some PDFs yield **partial** rows (missing revenue, EBIT, employees, or CEO) after validation discards implausible values.
- **Wrong or stale PDFs** can still slip through on edge cases; **wrong fiscal year** or **cached fallback** rows appear in notes — always read `extractionNotes` and `confidence`.
- **Banks (e.g. SEB)** and **hostname collisions** (e.g. SEB vs Groupe SEB) remain hard; entity rules live in `data/entity-confusion.json`.
- **Rate limiting / 403**: aggressive runs against sensitive hosts can trigger blocks; use `--slow` and space out reruns.

## Known broken or misleading (watch the output, not the label)

- **`status: "complete"`** means all four core financial fields are non-null after validation — it does **not** guarantee the PDF is the latest year or that sustainability or CEO strings are perfect.
- **Sustainability** extraction is best-effort; `confidence` there is separate from the main `confidence` score.
- **Committed `output/results.json`** may reflect ad-hoc runs, not only the default ten tickers — treat it as a sample unless you just ran the default batch.

## Prerequisites

- **Node.js** ≥ 18  
- **npm**  
- **Playwright + Chromium** (optional): required only for sites that need a real browser to expose PDF links.

## Installation

```bash
npm install
```

## Usage

### Default ten Large Cap tickers

If you omit both `--company` and `--ticker`, the CLI runs this fixed set (in order):

`VOLV-B.ST`, `ERIC-B.ST`, `HM-B.ST`, `ATCO-B.ST`, `SAND.ST`, `SEB-A.ST`, `INVE-B.ST`, `HEXA-B.ST`, `ESSITY-B.ST`, `ALFA.ST`

```bash
npx ts-node scrape.ts
npx ts-node scrape.ts --force
```

### One or more companies by ticker

Tickers are **comma-separated** (with or without spaces). Each is resolved via `data/ticker.json`.

```bash
npx ts-node scrape.ts --ticker "VOLV-B.ST"
npx ts-node scrape.ts --ticker "ERIC-B.ST,HM-B.ST" --force
```

### By free-text company name

No ticker resolution; useful for one-off tests. Names are comma-separated.

```bash
npx ts-node scrape.ts --company "Sandvik"
npx ts-node scrape.ts --company "Sandvik,Tele2" --force
```

### Useful flags

| Flag | Purpose |
|------|---------|
| `--force` | Ignore PDF cache and re-download / reprocess |
| `--slow` | Polite mode: longer base delay between requests |
| `--verbose` | Debug logging |
| `--llm-challenger` | When `OPENAI_API_KEY` is set, force the LLM challenger pass (still needs PDF text) |

## Adding a company in `data/ticker.json`

1. Add a key for the Nasdaq Stockholm symbol (e.g. `"EXAMPLE-B.ST"`).
2. Prefer an **object** entry with at least `"name"` and **`"irPage"`** (HTTPS investor URL you have verified in a browser).
3. Optionally add `"orgNumber"`, `"candidateDomains"`, `"isin"`, `"irEmail"` — see existing entries for shape.
4. **Do not overwrite the whole file from a script without a backup** (see `.cursorrules`).

Ticker resolution helpers live in `src/data/ticker-map.ts`.

## Default-set health (last benchmarked batch)

The following reflects a **full default-list run with `--force`** on **2026-04-05** (sequential processing, live sites). Your next run may differ.

| Ticker | Issuer (short) | Status | Confidence |
|--------|------------------|--------|------------|
| VOLV-B.ST | Volvo Group | partial | 85 |
| ERIC-B.ST | Ericsson | complete | 100 |
| HM-B.ST | H&M | complete | 100 |
| ATCO-B.ST | Atlas Copco | partial | 85 |
| SAND.ST | Sandvik | partial | 85 |
| SEB-A.ST | SEB | partial | 40 |
| INVE-B.ST | Investor AB | partial | 65 |
| HEXA-B.ST | Hexagon | partial | 85 |
| ESSITY-B.ST | Essity | partial | 85 |
| ALFA.ST | Alfa Laval | partial | 85 |

## Output schema (`output/results.json`)

Top level:

| Field | Type | Description |
|-------|------|-------------|
| `generatedAt` | string (ISO-8601) | When the file was written |
| `companyCount` | number | Number of rows in `results` |
| `results` | array | One object per company processed in the run / merge |

Each **result** object (public JSON — internal pipeline `stages` are stripped):

| Field | Type | Description |
|-------|------|-------------|
| `company` | string | Display / resolved company name |
| `ticker` | string \| null | Ticker if resolved |
| `website` | string \| null | Discovered or known site |
| `irPage` | string \| null | Investor relations URL used |
| `annualReportUrl` | string \| null | Chosen annual report PDF URL |
| `annualReportDownloaded` | string \| null | Local path under `downloads/` |
| `fiscalYear` | number \| null | Reporting year when detected |
| `extractedData` | object \| null | `revenue_msek`, `ebit_msek`, `employees`, `ceo` |
| `sustainability` | object | Scope 1/2, methodology, notes (best-effort) |
| `dataSource` | string \| null | e.g. `pdf`, `playwright+pdf`, `allabolag`, `ir-html` |
| `confidence` | number \| null | 0–100 validation confidence |
| `status` | string | `complete`, `partial`, or `failed` |
| `fallbackStepReached` | string | Last meaningful fallback (e.g. `cheerio`, `playwright`, `cached`) |
| `detectedCompanyType` | string \| null | `industrial`, `bank`, `investment_company` |
| `cached` | boolean | Whether this row reused a cached PDF path |
| `cachedAt` | string (optional) | When cache was used |
| `extractionNotes` | string[] | Human-readable trace / warnings |
| `dualTrackAdjudication` | object (optional) | Present when LLM challenger ran |

`output/run_summary.json` adds batch-level `failureClass` / bucket counts for triage.

## Dashboard

```bash
npm run server
```

Opens the Express app (default **http://localhost:3000/** unless `PORT` is set). Serves `app/swedish-largecap-dashboard.html`, exposes JSON APIs for ticker list and results, and can spawn `scrape.ts` as a child process for jobs.

## Environment

Copy `.env.example` to `.env` if you use tools that load it. The scraper does not require a `.env` for basic runs; see the example file for **PORT**, optional **OPENAI** / **LLM** variables, **ANTHROPIC** for `scripts/ir-health-check.mjs`, and reserved knobs.

## Tests

```bash
npx tsc --noEmit
npx jest
```

See `CONTRIBUTING.md` for conventions.

## License

Academic / evaluation project. Not intended for commercial use.
