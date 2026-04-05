# PROJECT HANDOFF — Swedish Large Cap Annual Report Scraper
# For the next AI agent continuing this project

## PROJECT OVERVIEW

This is a Node.js + TypeScript scraper for a high-stakes technical evaluation (AIFM case assignment). It discovers, downloads, and extracts structured financial data from annual reports of Swedish Large Cap companies listed on Nasdaq Stockholm.

**The assignment PDF requires:**
- Build a script that, for 10 Swedish Large Cap companies, automatically finds their website, navigates to Investor Relations, locates the latest annual report PDF, downloads it, extracts key financials, and writes results.json.
- Required fields: revenue_msek, ebit_msek, employees, ceo, fiscalYear
- Required stack: Node.js + TypeScript, cheerio for HTML, pdf-parse for PDF extraction
- Run via: npx ts-node scrape.ts
- Bonus: sustainability report CO2 extraction, single-company reruns, rate limiting

**Critical design principle:** The system must work for ANY Swedish Large Cap company entered at runtime, not just the 10 defaults. Company selection is a runtime parameter. The pipeline is company-agnostic — all company-specific knowledge lives in config/profiles.

## REPO LOCATION AND ACCESS

- GitHub: https://github.com/jakobtivell-cpu/epic_vibing
- Branch: main
- All source code is on disk in the workspace. Read files directly — do not ask for uploads.

## CURRENT STATE (as of latest session)

### What works:
- **Essity**: Complete, 4/5 fields, via cheerio. IR page found, correct 2025 PDF downloaded and extracted. Revenue 138,494 MSEK. ✓
- **Sandvik**: Complete, 5/5 fields, via cheerio. Revenue 122,878 MSEK, CEO Stefan Widing. ✓
- **Hexagon**: Complete, 5/5 fields, via cheerio (cached). Revenue 8,774 MSEK, CEO David Bandele. ✓
- **H&M**: Complete but with issues — downloaded 2020 report instead of 2025 due to entity check rejecting the correct PDF. CEO wrong (Karl-Johan Persson from old report). Entity check fix has been committed but not re-tested.
- **Volvo**: Previously complete via Playwright. Needs re-test after pipeline changes.

### What's broken or untested:
- **Ericsson**: Rate-limited (403) from previous burst of 70+ guessed URLs. Pipeline fix committed (IR before search). Needs cooldown then re-test.
- **Alfa Laval**: Currently running or just finished. IR page found correctly (URL sanitization fix worked), cheerio finds 0 PDFs (JS-rendered), Playwright should handle it. Fix committed to run Playwright early instead of after 500+ cheerio attempts.
- **SEB**: Known hard case — name collision with Groupe SEB (French company), bank with non-standard financials, sebgroup.com serves PDFs via JS. Entity checks block wrong-company PDFs. Allabolag org-number lookup works but yields sparse bank data.
- **Atlas Copco**: Revenue was wrong (3,168 instead of ~200,000). EUR/BSEK unit detection fix committed but untested on live PDF.
- **Investor AB**: Investment company — revenue/EBIT correctly null. Needs re-test for other fields.

### Pipeline improvements committed (not all tested live):
- IR discovery runs BEFORE search-guessed PDF URLs (prevents rate limiting)
- Search discovery skipped when trusted domains exist in ticker.json
- Playwright fires after first zero-PDF cheerio result (not after exhausting all probes)
- Flexible entity check with multiple signal types (legal name variants, ticker, org number, aliases)
- Stale report filtering (reports older than 2 years penalized)
- URL sanitization (encoded quotes, double slashes)
- Multi-ticker sequential runs with merge-safe results
- Per-host circuit breaker (3 failures = skip remaining on that host)
- Bank-specific extraction labels and validation thresholds
- CEO extraction context guard (skip AGM/nomination matches)
- Negative scoring for voting/proxy/AGM documents

## ARCHITECTURE

```
scrape.ts                         CLI entrypoint (commander)
  │
  ▼
src/pipeline.ts                   Orchestrator — runs stages per company
  │
  ├─► src/entity/
  │     entity-profile.ts         EntityProfile with legal name, ambiguity, collision rules
  │
  ├─► src/discovery/
  │     search-discovery.ts       Bing/DDG search, domain inference, brand slug extraction
  │     ir-finder.ts              IR page discovery with scored link ranking
  │     report-ranker.ts          PDF candidate scoring + fallback ladder
  │     report-corpus.ts          Publication hub URL probing
  │     candidate-ranking.ts      Entity-aware candidate filtering
  │     playwright-fallback.ts    Optional headless browser for JS-rendered pages
  │
  ├─► src/download/
  │     downloader.ts             PDF download with caching, magic-byte validation
  │
  ├─► src/extraction/
  │     text-extractor.ts         pdf-parse wrapper
  │     field-extractor.ts        Revenue/EBIT/employees/CEO/FY (bilingual, section-aware)
  │     labels.ts                 Swedish + English label dictionaries per company type
  │     schema-mapping.ts         Native field → assignment schema mapping
  │     sustainability-extractor  Scope 1/2 CO2 extraction
  │     allabolag-extractor.ts    Last-resort data from allabolag.se
  │     ir-html-extractor.ts      Key figures from IR page HTML
  │
  ├─► src/validation/
  │     validator.ts              Type-aware sanity checks and confidence scoring
  │     post-download-checks.ts   Entity verification, content type, FY cross-validation
  │
  └─► src/output/
        writer.ts                 Atomic JSON writes, merge support, console summary
```

### Key supporting files:
```
src/data/ticker-map.ts            Ticker resolution (VOLV-B.ST → AB Volvo)
data/ticker.json                  160 Nasdaq Stockholm tickers with names, org numbers, candidateDomains
data/entity-confusion.json        Hostname collision rules (e.g., SEB vs Groupe SEB)
src/config/settings.ts            Rate limits, timeouts, paths
src/types.ts                      All shared interfaces
.cursorrules                      Project rules for AI agents
```

### Pipeline flow:
```
CompanyProfile
  → Step 1: Search discovery (SKIPPED if trusted domains exist)
  → Step 2+3: Multi-domain cycling
      Per domain:
        → IR discovery (cheerio homepage scan, scored ranking)
        → Quick PDF scan on IR page
        → Publication hub probes (quick scan only)
        → Playwright on IR page (if cheerio found 0 PDFs)
        → Full cheerio fallback ladder (deep crawl + URL patterns + sitemap)
        → Try PDF candidates (download, verify entity, extract)
  → Step 1b: Deferred search (only if trusted domains failed)
  → Step 4: Direct PDF search via Bing
  → Step 5: IR HTML key figures extraction
  → Step 6: Allabolag via org number
  → Step 7: Cached result preservation
```

## .cursorrules (current version)

The .cursorrules file is in the repo root. Key policies:
- cheerio primary, Playwright optional fallback
- Deterministic heuristics for extraction, aggressive discovery for finding PDFs
- Null with explanation over fabricated values
- ticker.json candidateDomains are a cache, not a dependency
- Domain inference from brand names, not ticker slugs
- Validate inferred domains contain company name words
- Git commit after every successful fix

## CRITICAL LESSONS LEARNED

1. **Never run large architectural refactors in one session.** A 7-phase entity/corpus/mapping refactor broke 6 working companies. Small, tested, committed changes only.

2. **IR discovery before search-guessed PDFs.** The pipeline was burning rate limit budgets on 70+ guessed URLs before trying the real IR page. Now fixed: trusted domains skip search entirely.

3. **Playwright fires early, not last.** When cheerio finds 0 PDFs on an IR page, try Playwright immediately — don't exhaust 10 different guessed IR URLs with cheerio first.

4. **Entity check must be flexible.** Legal names don't appear in PDFs — brand names do. Check multiple signals: legal name variants, ticker, org number, aliases, brand tokens.

5. **Rate limiting is real.** Ericsson blocked the IP after too many requests. Wait hours or switch to mobile hotspot. Don't hammer sites with guessed URLs.

6. **Commit constantly.** The project lost a working state because all code was uncommitted. Now: commit after every fix, push regularly.

7. **Domain inference from ticker slugs is garbage.** "ERIC" → eric.se (wrong), "HM" → telepathy.com (wrong). Use the legal/brand name for domain inference, not the ticker.

## WHAT NEEDS TO HAPPEN NEXT (in priority order)

### 1. Test Alfa Laval result
The Playwright fix was just committed. Check if the run completed:
- Look at output/results.json for the ALFA.ST row
- If complete: commit and move on
- If failed: check logs for what Playwright found

### 2. Re-test H&M with entity check fix
The flexible entity check was committed but H&M hasn't been re-tested:
```bash
npx ts-node scrape.ts --ticker "HM-B.ST" --force
```
Expected: 2025 report downloaded (not 2020), CEO Daniel Ervér, revenue ~228,285 MSEK

### 3. Wait for Ericsson rate limit cooldown, then test
```bash
npx ts-node scrape.ts --ticker "ERIC-B.ST" --force
```
Expected: IR page at /en/investors, PDF at /492f5d/assets/.../annual-report-2025-en.pdf, revenue ~236,681 MSEK

### 4. Test Volvo (may need Playwright)
```bash
npx ts-node scrape.ts --ticker "VOLV-B.ST" --force
```
Expected: Playwright finds PDF on volvogroup.com, revenue ~457,509 MSEK

### 5. Test remaining companies
```bash
npx ts-node scrape.ts --ticker "ATCO-B.ST" --force
npx ts-node scrape.ts --ticker "INVE-B.ST" --force
npx ts-node scrape.ts --ticker "SEB-A.ST" --force
```

### 6. Full 10-company run
```bash
npx ts-node scrape.ts --force
```
Target: 6+ complete, 2 partial (SEB, Investor), 0 failed

### 7. After results are clean:
- Run Prompt 9 (hardening audit)
- Run Prompt 10 (README update)
- Run Prompt 11 (final review)
- Wire the dashboard (Phase 4 from prompt collection)

## KNOWN ISSUES AND EDGE CASES

| Issue | Root Cause | Status |
|-------|-----------|--------|
| Ericsson 403 rate limit | Previous session hammered with 70+ guessed URLs | Wait for cooldown |
| SEB name collision | "SEB" matches Groupe SEB (French appliances) | Entity check blocks wrong PDFs; bank PDF still hard to get |
| SEB bank extraction | Banks use different financial terms | Bank labels + schema mapping implemented |
| Investor AB no revenue | Investment company doesn't report standard revenue/EBIT | Correctly returns null with note |
| Atlas Copco wrong revenue | Unit context (EUR/BSEK) misdetected | Fix committed, untested |
| H&M old report selected | Entity check was too strict, rejected 2025 report | Flexible entity check committed, untested |
| Alfa Laval JS-rendered IR | PDF links rendered via JavaScript | Playwright early-fire fix committed |
| Domain inference garbage | Ticker slugs produce wrong domains | Brand-name-based inference implemented |

## IMPORTANT FILES TO READ FIRST

1. .cursorrules — project rules and constraints
2. scrape.ts — CLI entrypoint, ticker resolution, company list building
3. src/pipeline.ts — the orchestrator, step ordering, domain cycling
4. src/discovery/search-discovery.ts — domain inference, Bing search
5. src/discovery/ir-finder.ts — IR page discovery
6. src/discovery/report-ranker.ts — PDF candidate scoring
7. src/extraction/field-extractor.ts — financial data parsing
8. src/validation/post-download-checks.ts — entity verification
9. data/ticker.json — company profiles with domains and org numbers
10. output/results.json — current scrape results

## OUTPUT SCHEMA

```json
{
  "generatedAt": "2026-04-05T...",
  "companyCount": 10,
  "results": [
    {
      "company": "Ericsson",
      "ticker": "ERIC-B.ST",
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
        "reportUrl": "...",
        "scope1_co2_tonnes": 204,
        "scope2_co2_tonnes": 50,
        "methodology": "market-based",
        "confidence": "low",
        "note": "..."
      },
      "dataSource": "pdf",
      "confidence": 100,
      "status": "complete",
      "extractionNotes": []
    }
  ]
}
```

## GIT WORKFLOW

```bash
# After every successful fix:
git add -A && git commit -m "fix: [description]"

# After every successful test:
git add -A && git commit -m "verified: [company] complete"

# Push regularly:
git push origin main

# Before any risky change:
git add -A && git commit -m "snapshot: before [description]"
```

## RULES FOR THE NEXT AGENT

1. **Read the code before changing it.** Start by reading the 10 files listed above.
2. **Do NOT rewrite modules.** Make surgical fixes. The architecture is sound — the bugs are in data, ordering, and edge cases.
3. **Test one company at a time.** Don't run all 10 until individual companies work.
4. **Commit after every fix.** Never leave working code uncommitted.
5. **Don't hammer websites.** If a site returns 403, wait — don't retry immediately. Use --force only when needed.
6. **No company-specific hacks.** Every fix must be generic and work for any Swedish Large Cap company.
7. **Null over wrong values.** If extraction is uncertain, return null with an explanation.
8. **Check tsc --noEmit and npx jest before committing.** No regressions.

## DASHBOARD (future phase, not started)

A polished HTML dashboard mockup exists at app/swedish-largecap-dashboard.html. It needs to be wired to a real Express backend. Do NOT start this until the scraper produces clean results for 6+ companies. The dashboard prompt is in the Complete_Prompt_Collection.md file.

## REFERENCE FILES

- Complete_Prompt_Collection.md — all prompts used to build this project
- docs/ARCHITECTURE_ENTITY_AND_DISCOVERY.md — entity profiling and discovery architecture notes
- data/entity-confusion.json — hostname collision rules
