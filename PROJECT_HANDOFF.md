# PROJECT HANDOFF — Swedish Large Cap Annual Report Scraper

For the next maintainer or AI agent continuing this repository.

## Overview

Production-minded **Node.js + TypeScript** scraper for **Nasdaq Stockholm Large Cap** annual reports: IR / report discovery, PDF download (with cache), **pdf-parse** extraction, validation, and **`output/results.json`**. **Cheerio** is the primary HTML path; **Playwright** is an optional dependency for JS-rendered IR pages. **Per-host User-Agent rotation** and retry/backoff live in `src/utils/http-client.ts`.

**Core scraper:** public sites only — **no API keys required**.  
**Optional:** `OPENAI_API_KEY` (+ `OPENAI_BASE_URL`, `LLM_MODEL`) for the LLM challenger track. **Anthropic** is used only by `scripts/ir-health-check.mjs` (CI / workflow), not by the main scrape loop.

## Repository

- Remote: `https://github.com/jakobtivell-cpu/epic_vibing` (verify on clone).
- Entrypoints: `scrape.ts` (CLI), `server.ts` (Express dashboard).

## Current working state (completed)

- [x] Generic pipeline in `src/pipeline.ts` — not hardcoded to a single issuer list; default ten tickers are a CLI default string in `scrape.ts`.
- [x] `data/ticker.json` as the source of truth for ticker → legal name, optional **org**, **irPage**, **candidateDomains**, etc.
- [x] Ticker normalization and resolution (`src/data/ticker-map.ts`).
- [x] Search-assisted discovery, IR discovery, report ranking, publication-hub probes, entity-aware candidate filtering.
- [x] URL normalization (encoded quotes, double slashes) and same-site helpers (`src/utils/url-helpers.ts`).
- [x] Post-download entity verification and fiscal-year checks (`src/validation/post-download-checks.ts`).
- [x] Industrial / bank / investment-company extraction and validation paths.
- [x] Fused-year integer detection and revenue megascale / unit guards (`src/extraction/number-guards.ts`, wired from `field-extractor.ts`).
- [x] Playwright fallback (optional); early use when Cheerio finds no PDFs on the IR page; **2407d9f** also covers first **Axios 403** → Playwright retry.
- [x] Results writer with **merge by `company` name** (case-insensitive) for partial reruns.
- [x] Express server + dashboard HTML (`npm run server`).
- [x] Jest coverage for parsing guards, URL helpers, entity verification, ticker `irPage` HTTPS checks, validation plausibility, and discovery-related tests under `tests/`.

## Partial / ongoing quality

- Default-batch rows are not all **complete**; several issuers land **partial** after plausibility rules discard EBIT or other fields. Always read **`extractionNotes`** and **`confidence`**.
- **Banks** and **name collisions** (e.g. SEB) remain difficult; extend `data/entity-confusion.json` carefully when adding rules.
- **Rate limits**: some sites (historically Ericsson) may return **403** after aggressive probing; use `--slow` and cooldowns.

## Architecture (high level)

```
scrape.ts              CLI (commander) → buildCompanyList → runPipeline
server.ts              Express: UI + /api/* + scrape child processes

src/pipeline.ts        Stage orchestration
src/entity/            Entity profiles, ambiguity
src/discovery/         IR, report ranking, corpus, Playwright
src/download/          PDF fetch, cache, magic-byte check
src/extraction/        PDF text, fields, schema mapping, sustainability
src/validation/        Validator, post-download checks
src/output/            results.json, run_summary.json, merge, console summary
src/challenger/        Optional LLM dual-track (OpenAI)
src/utils/             http-client, logger, url-helpers
data/ticker.json       Ticker registry (data asset)
data/entity-confusion.json  Host / brand collision hints
```

## Output

- **`output/results.json`** — see README “Output schema” (public rows omit internal `stages`).
- **`output/run_summary.json`** — batch summary and `failureClass` per row.

## What needs to happen next (actual backlog)

1. **Re-benchmark the default ten** after any major discovery or extraction change: `npx ts-node scrape.ts --force`, then update the README status table and spot-check `extractionNotes`.
2. **Harden partial issuers** (SEB, Investor, etc.) with tests + small heuristic changes — avoid one-off site templates; prefer new rules backed by `tests/`.
3. **Dashboard polish** — UX, error surfacing, and job ergonomics as needed (server already runs scrapes).
4. **Optional:** wire `LOG_LEVEL` / `INTER_COMPANY_DELAY_MS` from env if you want README-documented knobs to affect runtime (today, use `--verbose` and `--slow`).

## Operational notes

- **Tests:** `npx tsc --noEmit` and `npx jest` before commits (see `.cursorrules`).
- **Playwright:** `npm install` then `npx playwright install chromium` when PDF links are JS-only.
- **Do not hammer sites**; prefer single-ticker `--force` reruns during development.

## Reference docs

- `README.md` — how to run, schema, dashboard, default ticker table.
- `CONTRIBUTING.md` — adding companies, commits, rate limits.
- `CHANGELOG.md` — version history (v2.1.0 current).
- `docs/ARCHITECTURE_ENTITY_AND_DISCOVERY.md` — deeper discovery / entity notes (if present).
