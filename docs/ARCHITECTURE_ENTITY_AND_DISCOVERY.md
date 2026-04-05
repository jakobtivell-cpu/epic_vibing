# Architecture: entity-aware discovery and schema mapping

## Current flow (after refactor)

1. **CLI** ([`scrape.ts`](../scrape.ts)) builds [`CompanyProfile`](../src/types.ts) (name, legalName, orgNumber, ticker, candidateDomains).
2. **Entity profiling** ([`src/entity/entity-profile.ts`](../src/entity/entity-profile.ts)) runs first in the pipeline: resolves `searchAnchor` (legal name preferred), `distinctiveTokens`, `ambiguityLevel`, optional hostname rejection rules from [`data/entity-confusion.json`](../data/entity-confusion.json).
3. **Discovery** uses `searchAnchor` for search-engine queries; short aliases remain secondary (ticker sharpening) with trust reflected in ambiguity, not chain order.
4. **Report corpus** ([`src/discovery/report-corpus.ts`](../src/discovery/report-corpus.ts)): after a base site exists, probes generic publication / reports-and-presentations hub paths; each 200 hub is scanned with the existing [`discoverAnnualReport`](../src/discovery/report-ranker.ts) so candidates come from an **archive/corpus**, not only the single IR landing page.
5. **Candidate ranking** ([`src/discovery/candidate-ranking.ts`](../src/discovery/candidate-ranking.ts)): adjusts PDF scores using entity (distinctive tokens in URL, confusion rules).
6. **Post-download** ([`verifyEntityInPdf`](../src/validation/post-download-checks.ts)): org number in text, high-ambiguity distinctive-token requirement, then existing name/alias logic.
7. **Extraction** ([`field-extractor.ts`](../src/extraction/field-extractor.ts)): company type from document; [`schema-mapping`](../src/extraction/schema-mapping.ts) documents native label → assignment field (`revenue_msek` / `ebit_msek`) with `exact` vs `mapped`.
8. **Validation** ([`validator.ts`](../src/validation/validator.ts)): industrial vs bank vs investment_company plausibility rules.

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

## Recent changes (maintenance note)

- **`data/entity-confusion.json`** patterns must be valid **JavaScript** `RegExp` sources. Do not use PCRE-only inline flags such as `(?i)`; use the `'i'` flag via code (the loader also strips a leading `(?i)` if present).
- **Rule file resolution** tries `process.cwd()/data/` first, then `__dirname`-relative paths, so tests and CLI runs from the repo root load rules consistently.
