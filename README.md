# Swedish Large Cap Annual Report Scraper

Call one scrape
npx ts-node scrape.ts --ticker "ALFA.ST" --force

Call subswequent scrapes
npx ts-node scrape.ts --ticker "ALFA.ST,ESSITY-B.ST,SAND.ST" --force

A Node.js + TypeScript pipeline that discovers, downloads, and extracts structured financial data from the annual reports of Swedish Large Cap companies. Given a list of company profiles (name, ticker, website), it autonomously finds each company's Investor Relations page, locates the most recent annual report PDF, downloads it, extracts key financial metrics from the raw text, validates the results, and writes everything to a structured JSON file. No API keys, no paid services, no manual intervention under normal conditions.

## Assignment Scope

Extract the following fields for each company from its most recent annual report:

| Field | Type | Source |
|-------|------|--------|
| `revenue_msek` | `number \| null` | Consolidated income statement |
| `ebit_msek` | `number \| null` | Consolidated income statement |
| `employees` | `number \| null` | Key figures / notes |
| `ceo` | `string \| null` | CEO letter / management section |
| `fiscalYear` | `number \| null` | Report title / front matter |

Bonus: Scope 1 and Scope 2 CO2 emissions from sustainability reports.

The system ships with 10 default companies (Volvo, Ericsson, H&M, Atlas Copco, Sandvik, SEB, Investor, Hexagon, Essity, Alfa Laval) but accepts any Swedish Large Cap company via a config file or CLI flag.

## Architecture

```
scrape.ts                         CLI entrypoint (commander)
  │
  ▼
src/pipeline.ts                   Orchestrator — runs stages sequentially per company
  │
  ├─► src/entity/
  │     entity-profile.ts         Legal-name anchor, ambiguity, collision rules, domain seeds
  ├─► src/discovery/
  │     ir-finder.ts              IR page discovery (hint → homepage → brute-force → sitemap)
  │     report-ranker.ts          PDF candidate scoring + fallback ladder
  │     report-corpus.ts          Publication / reports-hub URL probes (corpus expansion)
  │     candidate-ranking.ts      Entity-aware filter + score adjustments on candidates
  │     external-fallbacks.ts     Avanza, AEM CDN pattern fallbacks
  │     playwright-fallback.ts    Optional headless browser for JS-rendered pages
  │
  ├─► src/download/
  │     downloader.ts             PDF download with caching, magic-byte validation
  │
  ├─► src/extraction/
  │     text-extractor.ts         pdf-parse wrapper, whitespace normalization, scanned-PDF detection
  │     field-extractor.ts        Revenue/EBIT/employees/CEO/FY extraction (bilingual heuristics)
  │     schema-mapping.ts         Native label → assignment field (notes / provenance)
  │     labels.ts                 Swedish + English label dictionaries per company type
  │     sustainability-extractor  Scope 1/2 CO2 extraction with unit conversion
  │     allabolag-extractor.ts    Last-resort data fallback from allabolag.se
  │
  ├─► src/validation/
  │     validator.ts              Sanity checks, plausibility gates, confidence scoring
  │     post-download-checks.ts   Entity verification, content type checks, FY cross-validation
  │
  └─► src/output/
        writer.ts                 Atomic JSON writes, merge support, console summary
```

Supporting modules:

```
src/config/companies.ts           Default company registry (10 profiles)
src/config/settings.ts            Rate limits, timeouts, paths
src/types.ts                      All shared interfaces
src/utils/http-client.ts          Axios with retry, rate limiting, fetchBinary
src/utils/url-helpers.ts          URL resolution, same-site checks
src/utils/logger.ts               Leveled logger with timestamps
```

### Pipeline Flow

```
CompanyProfile
  → Build EntityProfile (legal anchor, ambiguity, collision rules)
  → Discover IR page (heuristic scoring, 4-step fallback)
  → Find annual report PDF (ranking + optional publication-hub corpus merge)
  → Download PDF (cached, magic-byte validated)
  → Extract text (pdf-parse, whitespace normalized)
  → Verify entity + content type (post-download gates)
  → Parse fields (section-aware, bilingual, unit-normalized)
  → Validate (plausibility checks, confidence 0–100)
  → Extract sustainability data (bonus, non-blocking)
  → Write result (atomic, merge-safe)
```

### Methodology: identity, corpora, and assignment mapping

The scraper is built for **classes** of failure (ambiguous tickers, bank reporting, sprawling IR sites), not one-off site hacks.

1. **Canonical entity first** — Before any HTTP discovery, the pipeline builds an `EntityProfile` (`src/entity/entity-profile.ts`): legal name as the **search anchor**, org number, ticker, distinctive tokens from the legal name, and an **ambiguity level** for short aliases. Data-driven **hostname collision rules** live in `data/entity-confusion.json` (extend this for new “same letters, different company” cases).

2. **Report corpus, not only one IR page** — After the primary annual-report discovery path, the pipeline probes generic **publication / reports hub** URL patterns (`src/discovery/report-corpus.ts`), merges unique PDF candidates, and **re-ranks** the combined set. Ranking is entity-aware (`src/discovery/candidate-ranking.ts`): penalties when a high-ambiguity issuer’s PDF host lacks legal-name evidence, bonuses when the org number appears in the URL, and drops for forbidden hosts.

3. **Native labels vs assignment fields** — Output JSON stays `revenue_msek` / `ebit_msek` / … for compatibility. Internally, extraction records how PDF labels map to those slots (`src/extraction/schema-mapping.ts`); notes include `SCHEMA_MAP[...]` lines with **exact / mapped / unsupported** semantics so reviewers see when a bank “revenue” is really operating income.

4. **Type-aware validation** — `src/validation/validator.ts` applies different plausibility logic for **industrial**, **bank**, and **investment_company** (e.g. banks are not forced through the same sub-1,000 MSEK “Large Cap industrial” revenue gate; EBIT vs revenue conflicts get bank-specific messaging).

5. **Stronger PDF gates** — Post-download entity checks (`src/validation/post-download-checks.ts`) accept org-number evidence and avoid over-trusting short aliases when ambiguity is high.

Together, this makes ambiguous issuers and non-industrial reports **first-class** without changing the assignment schema. For file-level flow and insertion points, see `docs/ARCHITECTURE_ENTITY_AND_DISCOVERY.md`.

## Prerequisites

- **Node.js** >= 18.x
- **npm** >= 9.x
- **Playwright** (optional) — only needed for companies with JS-rendered IR pages (e.g., Volvo). Install with `npx playwright install chromium` if needed.

## Installation

```bash
npm install
```

## Usage

### Run all 10 default companies

With no `--company` or `--ticker`, the CLI runs a fixed Large Cap list (Volvo, Ericsson, H&M, Atlas Copco, Sandvik, SEB, Investor, Hexagon, Essity, Alfa Laval), resolving each via `data/ticker.json` (including optional `candidateDomains` on some tickers).

```bash
npx ts-node scrape.ts
npx ts-node scrape.ts --force
```

### Run a single company

```bash
npx ts-node scrape.ts --ticker "VOLV B"
```

When using `--ticker`, only the target company is re-processed. Its row is merged into the existing `results.json` without overwriting other companies.

### Force re-download (ignore cache)

```bash
npx ts-node scrape.ts --force
```

### Re-run previously failed companies

```bash
npx ts-node scrape.ts --failed
```

### Use a custom company list

```bash
npx ts-node scrape.ts --config my-companies.json
```

The file must be a JSON array of `CompanyProfile` objects (see [Company Profiles](#company-profiles) below).

### Enable debug logging

```bash
npx ts-node scrape.ts --verbose
```

### Limit discovery (optional)

Skip headless browser PDF discovery (Cheerio and HTTP fallbacks only):

```bash
npx ts-node scrape.ts --no-playwright
```

Skip Avanza and AEM CDN pattern fallbacks after on-site discovery exhausts:

```bash
npx ts-node scrape.ts --skip-external
```

Flags compose with others (e.g. `npx ts-node scrape.ts --ticker "VOLV B" --no-playwright`).

## Output Format

Results are written to `output/results.json` (atomic write via temp file + rename). A run summary is written to `output/run_summary.json`.

`run_summary.json` includes `failureBuckets` (counts by coarse class: `complete`, `partial_pdf`, `allabolag_partial`, `no_ir`, `no_pdf`, `download_failed`, `extraction_failed`, etc.) and per-company `failureClass` for batch triage.

### results.json schema

```json
{
  "generatedAt": "2026-04-03T14:30:00.000Z",
  "companyCount": 10,
  "results": [
    {
      "company": "Ericsson",
      "ticker": "ERIC B",
      "website": "https://www.ericsson.com",
      "irPage": "https://www.ericsson.com/en/investors",
      "annualReportUrl": "https://...annual-report-2025-en.pdf",
      "annualReportDownloaded": "downloads/eric_b_2025_annual_report.pdf",
      "fiscalYear": 2025,
      "extractedData": {
        "revenue_msek": 236681,
        "ebit_msek": 38634,
        "employees": 89425,
        "ceo": "Börje Ekholm"
      },
      "sustainability": {
        "reportUrl": "https://...annual-report-2025-en.pdf",
        "reportDownloaded": "downloads/eric_b_2025_annual_report.pdf",
        "scope1_co2_tonnes": 2,
        "scope2_co2_tonnes": 50,
        "methodology": "market-based",
        "confidence": "low",
        "note": "Annual report includes sustainability content"
      },
      "dataSource": "pdf",
      "confidence": 100,
      "status": "complete",
      "extractionNotes": []
    }
  ]
}
```

### Status values

| Status | Meaning |
|--------|---------|
| `complete` | All 4 core fields extracted |
| `partial` | Some fields extracted, some null |
| `failed` | Pipeline failed at a specific stage |

### Data sources

| Source | Meaning |
|--------|---------|
| `pdf` | Extracted from the company's own annual report PDF |
| `playwright+pdf` | PDF found via headless browser fallback |
| `allabolag` | Statutory filing data from allabolag.se (last resort, confidence capped at 30) |

## Company Profiles

The pipeline is company-agnostic. All company-specific knowledge lives in a `CompanyProfile` object:

```json
{
  "name": "Volvo",
  "ticker": "VOLV B",
  "website": "https://www.volvogroup.com",
  "irHints": ["/en/investors"],
  "companyType": "industrial",
  "knownAliases": ["AB Volvo", "Volvo Group"],
  "entityWarnings": [
    "Do not confuse with Volvo Cars (volvocars.com)"
  ],
  "orgNumber": "556012-5790"
}
```

| Field | Purpose |
|-------|---------|
| `irHints` | Path fragments appended to `website` to try before homepage scanning |
| `companyType` | Selects the label dictionary: `industrial`, `bank`, or `investment_company` |
| `knownAliases` | Used by post-download entity verification to confirm the PDF belongs to this company |
| `entityWarnings` | Human-readable notes about common confusion (logged, not used programmatically) |
| `orgNumber` | Swedish org number; enables the allabolag.se data fallback |

To scrape a different set of companies, create a JSON file with an array of profiles and pass it via `--config`.

## Design Rationale

**Heuristic scoring over hardcoded selectors.** Every Swedish Large Cap company has a different website structure. H&M uses WordPress, Volvo uses AEM with JS-rendered content, Ericsson uses a custom CMS. Hardcoding CSS selectors or URL patterns per company would require per-site maintenance and would break whenever a redesign ships. Instead, the system scores every link on the IR page using a weighted combination of text content ("annual report" = +10), URL structure (`.pdf` = +5), context (under an "annual report" heading = +3), and recency (current fiscal year = +5). This approach degrades gracefully: a redesigned site scores lower but usually still finds the right PDF, and the confidence score tells you when to verify manually.

**Null with explanation over forced values.** When the extractor can't confidently identify a number as revenue, it returns `null` and logs exactly why — "Revenue not found for Sandvik" or "Investment company — standard revenue/EBIT not applicable." This is a deliberate trade-off: a missing value is recoverable (re-run with `--force`, check the notes, update the hints); a wrong value reported at 85% confidence is actively misleading. Every `null` in the output has a corresponding entry in `extractionNotes` explaining the decision. The validator applies the same principle: values that fail plausibility checks (revenue < 10,000 MSEK for Large Cap, EBIT exceeding revenue) are discarded and replaced with `null` rather than passed through with a warning.

**Runtime input model.** The company list is a configuration concern, not an architectural one. The default registry of 10 companies ships in `src/config/companies.ts`, but the pipeline code never references company names directly. This means adding a company is a config edit (or a CLI flag), not a code change. The `companyType` field drives label selection — banks use "Total operating income" where industrials use "Nettoomsättning" — and the `irHints` field gives the discovery system a head start without making it dependent on a specific URL.

**Extraction and validation as separate stages.** The field extractor is optimized for recall: find any number that could be revenue, using every label variant in both languages, across income statements, highlights sections, and general text. The validator is optimized for precision: reject numbers that are implausibly high, implausibly low, or internally inconsistent (EBIT > revenue). Separating these concerns means the extractor can be aggressive without producing garbage output, and the validator can be strict without needing to understand PDF parsing. Post-download checks (entity verification, content type detection, fiscal year cross-validation) sit between download and extraction as an additional gate against wrong-PDF and wrong-entity failures.

## Report Discovery Fallback Ladder

When the primary IR page scan doesn't find a PDF:

1. **Deep sub-page crawl** — follow report-related links one level deeper
2. **Direct URL construction** — HEAD-check common annual report URL patterns
3. **Sitemap.xml** — parse sitemaps for annual-report URLs
4. **Playwright** (optional) — render JS-heavy pages with headless Chromium
5. **Avanza / AEM CDN** — check external sources for PDF links
6. **Allabolag.se** — extract statutory filing data as a last resort (partial data, low confidence)

## Sustainability Extraction (Bonus)

The pipeline also attempts to extract Scope 1 and Scope 2 CO2 emissions:

- Reuses the same IR page discovery to find standalone sustainability report PDFs
- Falls back to extracting from combined annual + sustainability reports
- Three-pass Scope 2 search: market-based (preferred) → location-based → generic
- Handles unit conversion: tonnes, kilotonnes (kt), megatonnes (Mton), tCO2e
- Sustainability confidence is independent of financial confidence and capped at "medium" (less standardized data)
- Non-blocking: failures are caught and reported in notes without affecting core extraction

## Error Handling

- Every company produces a result row regardless of outcome — failures are recorded, not thrown
- Each pipeline stage returns a `StageResult<T>` with status, value, error, and duration
- Downstream stages receive a `skipped` result when upstream stages fail
- HTTP errors trigger retries with exponential backoff (max 3 attempts)
- PDF download validates magic bytes (`%PDF-`) and minimum file size
- Post-download checks verify entity identity, content type, and fiscal year before extraction
- The validator discards implausible values rather than passing them through
- All decisions are logged with timestamps and the originating module name

## Tests

```bash
npm test
```

Golden-style checks cover `parseNumber` and URL-pattern builders used in report discovery.

## Rate Limiting

- **Per-domain delay**: 1 second minimum between requests to the same domain
- **Inter-company delay**: 2 seconds between companies (configurable via `INTER_COMPANY_DELAY_MS`)
- **Request timeout**: 30 seconds per HTTP request
- **Max retries**: 3 per request, with exponential backoff
- **Playwright timeout**: 30 seconds per page load (20 seconds for sub-pages)

## Known Limitations

- **“100%” means best-effort, not a guarantee**: The goal is to maximize complete rows with honest provenance (`status`, `failureClass`, `extractionNotes`, `dataSource`). Sites change, definitions differ (group vs parent), and scrapers cannot promise correct five fields for every issuer every year.
- **Parent vs group figures**: Data from **allabolag.se** reflects statutory filings for the **legal entity** (often the parent company), not necessarily **group consolidated** numbers in the annual report. Prefer PDF discovery when group totals are required.
- **Banks and investment companies**: `companyType` selects label dictionaries; “revenue” and “EBIT” are not always meaningful or extractable to the same schema as industrials.
- **Broker / exchange pages as SPAs**: Avanza-style pages in the external tier are fetched as static HTML; when the link graph is empty in server HTML, Cheerio finds nothing. Fixing that would require a browser or API, not more HTML parsing. Nasdaq and similar sites are the same class of problem.
- **JS-rendered content**: Cheerio parses static HTML only. Companies with JS-rendered IR pages (e.g., Volvo) rely on the Playwright fallback (DOM links plus PDF `response` URLs). Install Chromium when needed (`npx playwright install chromium`).
- **Image-based PDFs**: `pdf-parse` extracts text from text-layer PDFs. Scanned/image-based reports yield very little text. The system detects this (`suspiciouslyShort` flag) but cannot OCR.
- **IR page changes**: Corporate websites are redesigned regularly. The `irHints` in company profiles may go stale. When they do, the system falls back to homepage scanning and brute-force paths, but some manual hint updates may be needed.
- **Non-standard financial schemas**: Banks report "Total operating income" instead of revenue; investment companies don't have meaningful revenue/EBIT. The `companyType` field handles this with separate label dictionaries, but edge cases exist.
- **Table column ordering**: PDF text does not preserve table layout. The extractor prefers a fiscal-year column when a two-year header is visible above the row, otherwise the **last** plausible numeric cell (common for current-year-right layouts), uses raw revenue to filter implausible EBIT picks, and returns **null** when multiple columns disagree wildly (ratio guard) instead of guessing.
- **CEO name accuracy**: The CEO extraction uses name-pattern matching near CEO labels. It can pick up wrong names when a non-CEO name (e.g., a company name that looks like a person's name) appears near a label match.

## Challenges Encountered

**Ericsson segment revenue vs. total revenue.** The first-number-after-label heuristic initially grabbed segment revenue (151,014 MSEK) from a segment breakdown table that appeared before the consolidated income statement. Fixed by implementing section-aware extraction: the system now identifies income statement sections by heading patterns and searches those first, falling back to highlights and general text only when no income statement match is found.

**Volvo's JS-rendered IR page.** Volvo Group's reports-and-presentations page renders its PDF links via client-side JavaScript, invisible to Cheerio. The static HTML contains zero PDF links. This required adding an optional Playwright fallback that launches headless Chromium, waits for the page to render, then extracts all `href` attributes from the rendered DOM. The fallback also follows report-related sub-pages to find PDFs behind one additional click.

**Fiscal year extraction from forward-looking statements.** The initial `findFiscalYear` function searched the entire document text, which would match forward-looking statements like "Financial year 2027 targets." For Volvo, this produced FY 2027 instead of 2025. Fixed by restricting the search to the first 3,000 characters (title page / report header), with a secondary pass up to 15,000 characters. Cross-validation against the discovery year catches remaining mismatches.

**Unit context ambiguity across report sections.** Annual reports sometimes declare "Amounts in SEK m" in the financial statements but present highlights in billions. A global unit context would apply the wrong multiplier to one of the two. Fixed by detecting unit indicators within ±5 lines of each section header and preferring the local context over the global one.

## Future Improvements

- **Table-aware PDF parsing** — integrate Tabula or Camelot for structured table extraction, eliminating column-ordering ambiguity
- **OCR fallback** — add Tesseract for image-based PDFs (currently detected but not processed)
- **Historical data** — extract multi-year time series from side-by-side tables, not just the most recent year
- **Confidence calibration** — compare extracted values against a known-good dataset to calibrate the confidence scoring model
- **Parallel company processing** — process multiple companies concurrently with per-domain rate limiting (currently sequential)
- **Incremental runs** — skip companies whose annual report URL hasn't changed since the last successful run

## License

Academic project. Not intended for commercial use.
