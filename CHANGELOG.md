# Changelog

Changes are grouped by area. Versions follow [Semantic Versioning](https://semver.org/).

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
