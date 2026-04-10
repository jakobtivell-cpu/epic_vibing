# Architecture: entity-aware discovery and schema mapping

## Current flow (after refactor)

1. **CLI** ([`scrape.ts`](../scrape.ts)) builds [`CompanyProfile`](../src/types.ts) (name, legalName, orgNumber, ticker, candidateDomains, optional override/CMS/aggregator fields from `ticker.json`).
2. **Entity profiling** ([`src/entity/entity-profile.ts`](../src/entity/entity-profile.ts)) runs first in the pipeline: resolves `searchAnchor` (legal name preferred), `distinctiveTokens`, `ambiguityLevel`, optional hostname rejection rules from [`data/entity-confusion.json`](../data/entity-confusion.json).
3. **Discovery** uses `searchAnchor` for search-engine queries; short aliases remain secondary (ticker sharpening) with trust reflected in ambiguity, not chain order.
4. **Report corpus** ([`src/discovery/report-corpus.ts`](../src/discovery/report-corpus.ts)): after a base site exists, probes generic publication / reports-and-presentations hub paths; each 200 hub is scanned with the existing [`discoverAnnualReport`](../src/discovery/report-ranker.ts) so candidates come from an **archive/corpus**, not only the single IR landing page.
5. **Playwright deepening rule** ([`src/discovery/playwright-fallback.ts`](../src/discovery/playwright-fallback.ts)): continue following likely report sub-pages unless a strong annual-report candidate score is already present, to avoid false early stopping on weak main-page PDFs.
6. **Candidate ranking** ([`src/discovery/candidate-ranking.ts`](../src/discovery/candidate-ranking.ts)): adjusts PDF scores using entity (distinctive tokens in URL, confusion rules).
7. **Post-download** ([`verifyEntityInPdf`](../src/validation/post-download-checks.ts)): org number in text, high-ambiguity distinctive-token requirement, then existing name/alias logic (including wider strong-term pass to reduce false negatives).
8. **Extraction** ([`field-extractor.ts`](../src/extraction/field-extractor.ts)): company type from document; [`schema-mapping`](../src/extraction/schema-mapping.ts) documents native label → assignment field (`revenue_msek` / `ebit_msek`) with `exact` vs `mapped`, including EBIT unit recovery guard behavior.
9. **Validation** ([`validator.ts`](../src/validation/validator.ts)): industrial vs bank vs investment_company vs real_estate plausibility rules.
10. **Preflight risk map path** ([`src/risk/preflight-evaluator.ts`](../src/risk/preflight-evaluator.ts), [`server.ts`](../server.ts)): deterministic non-scrape checks over ticker-map companies (IR reachability/signals/domain drift/JS heaviness), persisted to `output/preflight-risk.json`, served via `GET /api/risk-map`.

## Weak points this addresses (SEB-like class)

| Gap | Mitigation |
|-----|------------|
| Short brand overload (“SEB”) | Legal-name search anchor; high ambiguity; URL/host penalties; no short-alias entity pass without distinctive tokens |
| Single IR page too shallow | Publication hub paths → multiple `discoverAnnualReport` seeds → merged corpus |
| Implicit bank → “revenue” | Explicit mapping notes: bank operating income → `revenue_msek` as **mapped** |
| One-size validation | Bank: softer revenue floor, optional EBIT vs revenue rule |

## Insertion points (files)

- Pipeline start: [`processCompany`](../src/pipeline.ts) → `buildEntityProfile(company)`
- Search: `searchDiscovery(searchAnchor, ticker)` + `deriveShortNames(searchAnchor, ticker)`
- Domain sort / candidates: `filterAndRankReportCandidatesForEntity`, `shouldRejectReportUrl`
- IR loop: after `discoverIrPage`, `collectPublicationHubUrls` + extra `discoverAnnualReport` per hub
- PDF try: `verifyEntityInPdf(..., entityOpts)`
- Post-extract: `validateExtractedData(..., type, mappingNotes)`
- Preflight batch: `evaluatePreflightRiskForAll({ tickerJsonPath, outputPath })` (invoked by `POST /api/risk-map/evaluate`)

## Precision-first ticker overrides and fallbacks

Discovery order is **trust-tiered** (curated URLs and same-origin IR before broad search). New optional `ticker.json` fields are loaded into `CompanyProfile` and consumed in [`processCompany`](../src/pipeline.ts):

| Tier | Mechanism | Config |
|------|-----------|--------|
| 0 | Curated annual-report PDFs tried first | `annualReportPdfUrls`, optional `overrideFiscalYear` |
| 1–3 | Seeded `irPage`, Cheerio, publication hubs, optional Playwright, Cheerio deep ladder | existing `irPage` / `candidateDomains` |
| 4 | CMS / API JSON or HTML scanned for `.pdf` links | `cmsApiUrls` → [`cms-api.ts`](../src/discovery/cms-api.ts) |
| 8 | Trusted aggregator pages or PDFs | `aggregatorUrls` → [`aggregator-fallback.ts`](../src/discovery/aggregator-fallback.ts) (host allowlist) |

**Playwright:** `PLAYWRIGHT_ENABLED=false` or per-host `PLAYWRIGHT_DISABLED_HOSTS` skips browser launch when the runtime cannot load bundled Chromium (e.g. missing `libglib` on minimal Linux).

**Telemetry:** [`writeRunSummary`](../src/output/writer.ts) adds `fallbackStepBuckets` and per-company `fallbackStepReached` plus parsed `rejectionTelemetry` from pipeline notes.

**Template:** see [`ticker-json-template.md`](ticker-json-template.md).

## Recent changes (maintenance note)

- **`data/entity-confusion.json`** patterns must be valid **JavaScript** `RegExp` sources. Do not use PCRE-only inline flags such as `(?i)`; use the `'i'` flag via code (the loader also strips a leading `(?i)` if present).
- **Rule file resolution** tries `process.cwd()/data/` first, then `__dirname`-relative paths, so tests and CLI runs from the repo root load rules consistently.
- **Risk map persistence split:** `/api/results` lifecycle does not own risk data anymore; risk view should read `/api/risk-map` (preflight file first, scrape-derived fallback second).
- **Seeded `irPage` behavior:** ticker seed is a preferred first scan, but no longer marks host as exhausted up-front; same-domain IR discovery still runs when seed URL is stale/moved.
- **Cheerio PDF discovery hardening:** report ranker now also extracts embedded PDF URLs from raw HTML/script payloads (including escaped `https:\/\/...pdf`) for CMS/MFN pages with weak anchor markup.
