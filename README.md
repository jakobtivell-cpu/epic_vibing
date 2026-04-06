# Swedish Large Cap Annual Report Scraper

**Version 2.1.1**

This project is a **Node.js + TypeScript** system for **Nasdaq Stockholm Large Cap** issuers: it discovers investor-relations entry points and annual-report PDFs, extracts consolidated figures with **deterministic heuristics**, runs **type-aware validation**, and emits **`output/results.json`** with explicit provenance. The stack is built for **repeatable batch operation**, **merge-safe partial reruns**, and **reviewability** (`extractionNotes`, numeric confidence). The **core scraper** uses **public websites only** (no API keys required). **OpenAI** optionally powers an LLM challenger pass; **Anthropic** is used only by the **IR health-check** script (see [Environment](#environment)).

## Capabilities

- **End-to-end pipeline** for arbitrary Swedish Large Cap names (`--company`) or Nasdaq Stockholm tickers (`--ticker`), resolved through `data/ticker.json`.
- **Verified `irPage` URLs** in `ticker.json` skip brittle IR discovery for those rows.
- **Cheerio-first HTML**, **pdf-parse** for text, optional **Playwright** for JS-rendered IR pages (install Chromium when needed: `npx playwright install chromium`).
- **Per-host User-Agent rotation**, retries, and backoff in `src/utils/http-client.ts`.
- **Entity-aware PDF checks**, URL normalization (encoded quotes, double slashes), fused-year and unit guards in extraction, type-aware validation (industrial / bank / investment company).
- **EBIT (`ebit_msek`)** — broad direct label set (20+ Swedish / English phrases, including *rörelseresultat före finansiella poster*, *resultat före finansnetto*, *profit before net financial items*, etc.) and ordered fallbacks when no direct line matches: **adjusted EBIT-style labels** (with extraction notes), **operating margin × revenue** (when revenue is high-confidence table extraction, not narrative BSEK / allabolag), **EBITA minus amortization of intangibles** (±10 lines), and **sum of segment results** explicitly *before financial items* (with verification notes). EBITDA is intentionally not derived.
- **Merge-safe reruns**: processing one ticker updates that company’s row in `results.json` by matching **`company` name** (case-insensitive), leaving other rows unchanged.
- **Express dashboard** (`npm run server`): static UI, API for results, scrape jobs with log streaming (see [Dashboard](#dashboard)).

## Architecture

The CLI (`scrape.ts`) resolves companies from flags and `data/ticker.json`, then runs a **sequential** pipeline in `src/pipeline.ts`—an intentional choice to keep **per-host rate limits predictable** and logs ordered. Stages are separated by concern: **entity profiling** (`src/entity/`), **discovery** (IR, report ranking, publication hubs, optional Playwright in `src/discovery/`), **download** with cache and magic-byte checks (`src/download/`), **extraction** and schema mapping (`src/extraction/`), **validation** and post-download gates (`src/validation/`), and **atomic output + merge** (`src/output/`). The **fallback ladder** (Cheerio → Playwright where needed, search and other tiers as implemented) is **ordered by design**, not an ad hoc accumulation of retries. **`null` over wrong values** is enforced in extraction and validation so implausible numbers are dropped with a trace in `extractionNotes` rather than shipped as facts.

## Known edge cases

- **Issuer-to-issuer variance in row completeness**: some PDFs end as **`partial`** after validation discards implausible values. **Mitigation:** read `extractionNotes` and `confidence`; extend heuristics and tests under `tests/`; re-run single tickers with `--force` after fixes.
- **Edge-case PDF selection**: wrong or stale PDFs or fiscal-year skew can still appear in rare paths; **cached** fallback rows are labeled in notes. **Mitigation:** rely on `extractionNotes`, stale-report penalties, and entity checks; tighten ranking rules with regression tests.
- **Banks and hostname collisions** (e.g. SEB vs Groupe SEB): deliberately handled via **`data/entity-confusion.json`** and bank-specific label paths; remaining gaps are addressed by extending that data and validation tests, not one-off site scripts.
- **HTTP 403 / rate limits** on sensitive hosts under aggressive parallelism or burst discovery. **Mitigation:** **`--slow`**, spacing reruns, and the existing client backoff / per-host discipline in `src/utils/http-client.ts`.

## Engineering trade-offs and future work

- **EBIT extraction (resolved in v2.1.1):** The extractor now chains **direct labels → adjusted EBIT variants → margin × revenue → EBITA − intangibles amortization → segment aggregation before financial items**, each with explicit `extractionNotes` when a fallback path is used. **Remaining edge cases:** validation can still discard EBIT (e.g. implausible vs revenue); banks and odd PDF layouts may need more labels or human review—same **null-over-wrong** policy as other fields.
- **`status: "complete"`** means all four core financial fields are non-null after validation—it does **not** assert latest fiscal year or perfect CEO/sustainability strings. **Mitigation:** operators use `fiscalYear`, `annualReportUrl`, and notes; further tightening is a validation and ranking roadmap item.
- **Sustainability** fields are extracted on a **non-blocking** path; the sustainability `confidence` field is separate from the main **`confidence`** score. **Mitigation:** interpret both fields independently; optional hardening of sustainability gates can follow the same test-backed pattern as financial validation.
- **Committed `output/results.json`** may reflect ad-hoc runs, not only the default ten tickers. **Mitigation:** treat repo snapshots as samples unless you have just run the default batch; README status table documents one benchmark date.

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
| ERIC-B.ST | Ericsson | complete | 100 |
| HM-B.ST | H&M | complete | 100 |
| ALFA.ST | Alfa Laval | partial | 85 |
| ATCO-B.ST | Atlas Copco | partial | 85 |
| ESSITY-B.ST | Essity | partial | 85 |
| HEXA-B.ST | Hexagon | partial | 85 |
| INVE-B.ST | Investor AB | partial | 65 |
| SAND.ST | Sandvik | partial | 85 |
| SEB-A.ST | SEB | partial | 40 |
| VOLV-B.ST | Volvo Group | partial | 85 |

*EBIT vs this snapshot:* In the committed `output/results.json` from that run, **`ebit_msek` was null** for **VOLV-B, ATCO-B, SAND, SEB-A, INVE-B, HEXA-B, ESSITY-B,** and **ALFA.ST** (often after validation discarded a bad pick, or no line matched older heuristics). **v2.1.1** adds the label and derivation paths above—**some of those rows may move toward non-null EBIT after a fresh `--force` scrape**; re-run the default batch and refresh this table when you want numbers to match the latest extractor.

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
| `sustainability` | object | Scope 1/2, methodology, notes (non-blocking; separate from core financial gate) |
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

Opens the Express app (default **http://localhost:3000/** unless `PORT` is set). Serves `app/swedish-largecap-dashboard.html`, exposes JSON APIs for ticker list and results, and spawns **`node dist/scrape.js`** (with working directory set to the app root) for dashboard scrape jobs.

## Production build and Azure

- Run **`npm run build`** then **`npm start`** (`node dist/server.js`). Output, downloads, cache, and **`GET /api/results`** all use the same project root via [`src/config/settings.ts`](src/config/settings.ts): from compiled `dist/src/config` the root is resolved three levels up; from source `src/config` it is two levels up. Set **`APP_ROOT`** (see [Environment](#environment)) if the app files live in a non-standard layout.
- Keep **`data/`** next to **`dist/`** at deploy root so `data/ticker.json` and related JSON load from `{PROJECT_ROOT}/data/`. A fallback to `dist/data/ticker.json` still works if you mirror data there.
- **Playwright** is an **`optionalDependency`**; **`postinstall`** runs **`npx playwright install chromium`**. For the browser fallback on Azure, avoid **`npm install --omit=optional`**. On Linux, the code uses **bundled Chromium** (no system Chrome); macOS/Windows may try the **`chrome`** channel first, then fall back.

## Environment

Copy `.env.example` to `.env` if you use tools that load it. The scraper does not require a `.env` for basic runs; see the example file for **PORT**, optional **`APP_ROOT`**, optional **OPENAI** / **LLM** variables, **ANTHROPIC** for `scripts/ir-health-check.mjs`, and reserved knobs.

## Tests

```bash
npx tsc --noEmit
npx jest
```

See `CONTRIBUTING.md` for conventions.

## License

Academic / evaluation project. Not intended for commercial use.
