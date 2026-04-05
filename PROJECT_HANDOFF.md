# Project handoff — Epic_vibing (Swedish Large Cap annual report scraper)

## Purpose

TypeScript/Node pipeline: resolve a company (ticker or name), discover IR / annual report PDFs, download, extract revenue/EBIT/employees/CEO/fiscal year (+ optional sustainability), validate, write JSON. No API keys for core flow.

## Quick start

```bash
npm install
npx ts-node scrape.ts --ticker "VOLV-B.ST"
npx ts-node scrape.ts --ticker "ALFA.ST,ESSITY-B.ST,HM-B.ST"   # comma-separated, sequential, merge into results.json
npx ts-node scrape.ts                                          # default 10 Large Cap tickers (parallel)
```

Outputs (by default under `output/`): `results.json`, `run_summary.json` (both gitignored except where noted below).

## High-signal source files

| Area | Path |
|------|------|
| CLI | `scrape.ts` |
| Orchestration | `src/pipeline.ts` |
| Entity / seeds | `src/entity/entity-profile.ts`, `data/ticker.json` |
| IR discovery | `src/discovery/ir-finder.ts` |
| Report / PDF candidates | `src/discovery/report-ranker.ts` (`skipFallbackLadder`, `quickScanPdfCandidatesOnPage`) |
| URL hygiene | `src/utils/url-helpers.ts` (`resolveUrl` sanitizes `%22`, `//`) |
| Entity PDF check | `src/validation/post-download-checks.ts` (`buildEntityCheckTerms`, `verifyEntityInPdf`) |
| Stale year filter | `src/discovery/report-candidate-stale-year.ts`, `candidate-ranking.ts` |
| Results IO | `src/output/writer.ts` (`mergeResults` vs `writeResults`) |

## Behaviour notes (recent design)

1. **Trusted domains**: If `candidateDomains` or `website` exist, Step 1 search discovery is skipped initially; it runs deferred only if IR path fails to extract.
2. **IR → Playwright ordering**: First `discoverAnnualReport` on the chosen IR URL uses `skipFallbackLadder: true` so the internal 28-page / pattern / sitemap ladder does not run before **Playwright** on the same IR URL. Publication hubs from `report-corpus` use **quick single-page** scans only. One full Cheerio ladder runs **after** Playwright if still no extraction.
3. **Comma tickers**: Explicit `--ticker "A,B,C"` or `--company` lists run **sequentially** and **merge** into `results.json`. Default 10-ticker run with no flags stays **parallel** and **overwrites** `results.json`.
4. **Frontend / API**: A future `POST /api/scrape` with `{ "tickers": ["ALFA.ST", …] }` can mirror CLI: split list, build `CompanyProfile[]`, call `runPipeline(..., { sequential: true })`, then `mergeResults`.

## Current results snapshot

A committed copy of the last captured run summary lives at **`output/results_snapshot.json`** (see timestamp inside). Live `output/run_summary.json` / `output/results.json` remain gitignored for day-to-day runs.

_Last handoff update: committed with snapshot file; no separate external handoff path was supplied._
