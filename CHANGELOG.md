# Changelog

Changes are grouped by area. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Dashboard / Risk Map

- Added persistent preflight risk dataset support via `output/preflight-risk.json`.
- Added `POST /api/risk-map/evaluate` to run deterministic preflight risk evaluation for all ticker-map companies without running full scrapes.
- `GET /api/risk-map` now prefers persisted preflight risk data, so risk assessments remain visible even when scrape results are cleared.
- UI updates:
  - `Risk Map` tab is always visible (independent of scrape table state).
  - Scrape run cards now render in a 3-column grid.
  - Added per-run **copy text** action that copies only that run's log text for error tracking.

### Risk scoring

- Tuned deterministic scoring to increase risk when both revenue and EBIT unit guards are present, improving visibility for layout-fragile "recently fixed" companies.

### Discovery / extraction hardening

- Precision-first pipeline tiers: optional **`annualReportPdfUrls`** (curated PDF override before discovery), **`cmsApiUrls`** (CMS/API PDF discovery), **`aggregatorUrls`** (allowlisted MFN/Nasdaq/Cision hosts), extended **`FallbackStep`** values, and **`PLAYWRIGHT_ENABLED` / `PLAYWRIGHT_DISABLED_HOSTS`** env toggles.
- `run_summary.json` now includes **`fallbackStepBuckets`**, per-company **`fallbackStepReached`**, and **`rejectionTelemetry`** for regression tracking.
- Documentation: **`docs/ticker-json-template.md`** copy-paste template for rich ticker entries.
- Seeded ticker `irPage` is now treated as a preferred first attempt instead of a hard host lock, so stale seeds no longer prevent same-domain IR discovery.
- Updated deterministic IR seeds/domains for difficult issuers (including Systemair, Bure, and Industrivärden) to reduce `.net`/moved-page 404 failures in cloud runs.
- Report ranking now scans raw HTML/script payloads for embedded PDF URLs (plain and escaped forms), improving non-Playwright coverage on CMS/MFN-backed pages.
- CEO extraction now rejects ESEF/non-person phrases (for example “Single Electronic Format”) and investment-company employee extraction discards likely portfolio-level headcount values.

## [2.1.2] — 2026-04-07

### Discovery

- Deterministic Playwright deepening: sub-page exploration now continues unless a strong annual-report candidate is already found on the main IR page.
- Improved candidate handling diagnostics and deterministic rejection tracing in pipeline fallback paths.

### Extraction

- EBIT unit recovery hardening: accepts large raw EBIT candidates when revenue context supports it, then applies a 1000x megascale correction when plausible.
- Added regression tests for EBIT unit guard behavior (recover vs reject).

### Validation

- Expanded entity verification strategy with stronger long-window matching to reduce false negatives on valid annual reports.

### Infrastructure

- Removed legacy Playwright shared-library injection path (`LD_LIBRARY_PATH`) and workflow-time `ldd` bundle coupling that caused glibc conflicts.
- Confirmed successful Azure run for `TELIA.ST` via `playwright+pdf` with complete extraction.

## [2.1.1] — 2026-04-06

### Extraction

- Expanded EBIT extraction — added derivation strategies including adjusted EBIT variants, operating margin × revenue, EBITA minus amortization, and segment result aggregation; added 20+ Swedish and English label variants.

## [2.1.0] — 2026-04-05

Release **2.1.0** ships documentation aligned with the live pipeline, regression tests around parsing and URLs, extraction guards for fused years and megascale revenue, version metadata, and handoff artifacts.

### Discovery

- Search and domain discovery improvements; seed `candidateDomains` and sequential slug checks (`cd82a57`, `c26982b`).
- Defer search discovery when trusted domains or website already exist (`3f3e380`).
- IR discovery ordered before speculative search-guessed PDF URLs (`304d6b9`).
- `irPage` on ticker entries and `CompanyProfile` for direct IR URL handling (`9575c0d`).
- URL enrichment and ticker IR tooling fixes (`07d910f`, `27b8517`).
- Telia seed (`teliacompany.com`, org number) (`e2378dc`).
- Playwright after first zero-PDF IR probe instead of exhausting all Cheerio attempts (`7628e48`).
- Playwright fallback when first Axios response is **403** (`2407d9f`).

### Extraction

- PDF fetch and revenue extraction improvements; entity PDF checks (`311e25b`, `52f561a`, `f6f1711`).
- Fused-year and MSEK megascale guards (number-guards + field extractor integration) — this release.

### Validation

- Flexible entity check and stale-report penalty (`0fcd510`).
- Sanitize encoded quotes and double slashes in resolved URLs (`bbd7eee`).

### Frontend

- Express dashboard server and `app/swedish-largecap-dashboard.html` wiring (`server.ts`).

### Infrastructure

- Optional LLM challenger track (OpenAI) (`41685fe`, `63df7e3`).
- Multi-ticker comma-separated CLI runs with merge-safe `results.json` (`244adcc`).
- Comma-separated ticker handling and discovery logging fixes (`569bd70`, `db4d6f5`).
- `toAbsoluteHttpUrl` and URL normalization (`f2cff03`, `772d5c9`).
- Project handoff and results snapshots (`761e21f`, `63df7e3`).
- README / CONTRIBUTING / CHANGELOG / `.cursorrules` non-regression rules — this release.

### Earlier history

- **2.0.x and prior** — Initial scaffold, rename dashboard asset, core pipeline and ticker map (`a973d25`, `fe0588c`, `135aa03`, …).

[2.1.1]: https://github.com/jakobtivell-cpu/epic_vibing/commits/main
[2.1.0]: https://github.com/jakobtivell-cpu/epic_vibing/compare/a973d25...HEAD
[2.1.2]: https://github.com/jakobtivell-cpu/epic_vibing/commits/main
