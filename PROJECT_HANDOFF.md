# PROJECT_HANDOFF — Swedish Large Cap Annual Report Scraper

For the next maintainer or AI agent continuing this repository.

## Overview

Production-minded **Node.js + TypeScript** scraper for **Nasdaq Stockholm Large Cap** annual reports: IR / report discovery, PDF download (with cache), **pdf-parse** extraction, validation, and **`output/results.json`**. **Cheerio** is the primary HTML path; **Playwright** is an optional dependency for JS-rendered IR pages. **Per-host User-Agent rotation** and retry/backoff live in `src/utils/http-client.ts`.

**Core scraper:** public sites only — **no API keys required**.  
**Optional:** `OPENAI_API_KEY` (+ `OPENAI_BASE_URL`, `LLM_MODEL`) for the LLM challenger track. **Anthropic** is used only by `scripts/ir-health-check.mjs` (CI / workflow), not by the main scrape loop.

## Repository

- Remote: `https://github.com/jakobtivell-cpu/epic_vibing` (verify on clone).
- Entrypoints: `scrape.ts` (CLI), `server.ts` (Express dashboard).

## Delivered capabilities

- [x] Generic pipeline in `src/pipeline.ts` — not hardcoded to a single issuer list; default ten tickers are a CLI default string in `scrape.ts`.
- [x] `data/ticker.json` as the source of truth for ticker → legal name, optional **org**, **irPage**, **candidateDomains**, etc.
- [x] Ticker normalization and resolution (`src/data/ticker-map.ts`).
- [x] Search-assisted discovery, IR discovery, report ranking, publication-hub probes, entity-aware candidate filtering.
- [x] URL normalization (encoded quotes, double slashes) and same-site helpers (`src/utils/url-helpers.ts`).
- [x] Post-download entity verification and fiscal-year checks (`src/validation/post-download-checks.ts`).
- [x] Industrial / bank / investment-company / real-estate extraction and validation paths.
- [x] EBIT field extraction with **priority-ordered strategies** in `field-extractor.ts` / `labels.ts`: **(1)** direct table labels (expanded SV/EN set), **(2)** adjusted EBIT-style labels (annotated in notes), **(3)** operating margin × revenue when revenue is high-confidence, **(4)** EBITA minus amortization of intangibles nearby, **(5)** sum of segment operating results explicitly before financial items. No EBITDA derivation by design.
- [x] Fused-year integer detection and revenue megascale / unit guards (`src/extraction/number-guards.ts`, wired from `field-extractor.ts`).
- [x] EBIT megascale/unit guard to recover likely tkr/KSEK 1000x inflation against revenue context (with notes and tests).
- [x] Playwright fallback (optional); early use when Cheerio finds no PDFs on the IR page; **2407d9f** also covers first **Axios 403** → Playwright retry.
- [x] Playwright fallback deepening: continue exploring report sub-pages unless a strong annual-report candidate is already present.
- [x] Legacy `playwright-linux-libs` / `LD_LIBRARY_PATH` injection removed to avoid glibc conflicts in Azure Linux runtime.
- [x] Results writer with **merge by `company` name** (case-insensitive) for partial reruns.
- [x] Express server + dashboard HTML (`npm run server`).
- [x] Jest coverage for parsing guards, URL helpers, entity verification, ticker `irPage` HTTPS checks, validation plausibility, and discovery-related tests under `tests/`.

## Engineering backlog (honest current frontier)

Each item below is an **expected** frontier for this problem class, not a surprise defect.

### Partial rows on the default batch

- **What:** Several default issuers can still finish as **`partial`** when plausibility rules null out extracted figures (including EBIT after a candidate is deemed inconsistent with revenue or reporting model).
- **Why this is acceptable now:** The pipeline prefers **recoverable nulls** over shipping numbers that fail industrial / bank consistency checks; the row still carries URLs, notes, and confidence for human or downstream review. **EBIT-specific gap-filling** (extra labels + margin / EBITA / adjusted / segment paths) is **shipped in v2.1.1**—remaining partials are validation or layout edge cases, not “missing EBIT logic.”
- **Resolution path:** Extend heuristics and **`tests/`** coverage per issuer class; re-benchmark with `npx ts-node scrape.ts --force` and update the README status table.

### Banks and brand / hostname collisions

- **What:** SEB-style banks and collisions (e.g. vs Groupe SEB) need explicit entity and host rules.
- **Why this is acceptable now:** Collision data lives in **`data/entity-confusion.json`** and is loaded into entity profiling; the alternative—silent trust—would violate the **null-over-wrong** rule.
- **Resolution path:** Add or refine collision entries and bank label coverage; validate with entity and extraction tests.

### HTTP 403 and rate-shaped responses

- **What:** Some hosts return **403** or throttle under burst discovery patterns.
- **Why this is acceptable now:** The HTTP client already implements backoff, rotation, and optional **Playwright** retry on first **403**; sequential runs reduce cross-company pile-on.
- **Resolution path:** Use **`--slow`** and spaced reruns during development; adjust delays or host policy in `src/utils/http-client.ts` only with **jest** before/after per `.cursorrules`.

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

## Roadmap (next engineering steps)

1. **Re-benchmark the default ten** after any major discovery or extraction change: `npx ts-node scrape.ts --force`, then update the README status table and spot-check `extractionNotes`.
2. **Close partial issuers** (SEB, Investor, others) with **test-backed** heuristic increments—avoid per-site templates; ship rules that generalize.
3. **Dashboard** — UX, error surfacing, and job ergonomics as needed (server already runs scrapes).
4. **Optional env wiring** for `LOG_LEVEL` / `INTER_COMPANY_DELAY_MS` if operators want those knobs without CLI flags (today: **`--verbose`** and **`--slow`**).

## Operational notes

- **Tests:** `npx tsc --noEmit` and `npx jest` before commits (see `.cursorrules`).
- **Playwright:** `npm install` then `npx playwright install chromium --with-deps` on Linux/Azure build runners when PDF links are JS-only.
- **Host respect:** Prefer single-ticker **`--force`** during iterative work to keep request volume predictable.

## Reference docs

- `README.md` — how to run, schema, dashboard, default ticker table.
- `CONTRIBUTING.md` — adding companies, commits, rate limits.
- `CHANGELOG.md` — version history (v2.1.1 current for extraction notes; see file for full list).
- `docs/ARCHITECTURE_ENTITY_AND_DISCOVERY.md` — deeper discovery / entity notes (if present).
