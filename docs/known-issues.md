# Known Issues — Full Scrape Analysis (2026-04-15, post-fix-round-1)

Additional failure patterns from `output/results.json` (136 companies:
88 complete, 23 partial, 3 failed, 22 timeout). These are NOT yet fixed.

## 1. Pipeline timeouts (22/136 companies — 16.2%)

Companies timing out at 210s: ABB, Electrolux, Ericsson, Handelsbanken,
Swedbank, DNB, Stora Enso, Saab, NIBE, Sinch, and others.

Root causes: complex JS-heavy IR pages exhausting Playwright budget, deep
sub-page crawl + fallback ladder consuming the timeout, or IR page not
discovered at all.

Potential fix: curate `irPage`/`annualReportPdfUrls` overrides in
`data/ticker.json` for the 22 timeout companies, or increase per-company
timeout for known-slow sites.

## 2. KSEK/wrong-scale revenue (inflated by 1000x)

Several companies have revenue values 100x–1000x too large, suggesting
the extractor read KSEK or TSEK values without downscaling to MSEK:

| Company | Revenue (MSEK) | Expected ~MSEK | Employees |
| --- | --- | --- | --- |
| Atrium Ljungberg | 2,988,000 | ~3,000 | 111 |
| Wihlborgs | 4,354,000 | ~4,350 | 156,152 (also wrong) |
| Bonesupport | 591,077 | ~591 | 9,008 |
| Camurus | 532,265 | ~532 | null |
| Hacksaw | 313,855 | ~314 | 439,453 (also wrong) |
| Bilia | 530,804 | ~38,000 | 5,559 |
| Systemair | 301,512 | ~13,500 | 6,555 |

Potential fix: strengthen the KSEK guard in `applyRevenueMegascaleMsekGuard`
to cross-check revenue/employee ratios for obvious 1000x misscale.

## 3. False EUR detection (Holmen AB)

Holmen is a Swedish company reporting in SEK, but `detectUnitContext` matched
an EUR pattern early in the document (possibly from a footnote about EUR-
denominated debt). Revenue was then multiplied by 11.25, inflating from
~15,400 → 173,554 MSEK.

Potential fix: require EUR/USD unit markers to appear near financial table
headers (income statement context), not just anywhere in the document.

## 4. Wrong document type selected

- Sandvik — auditors' remuneration PDF (no P&L, all financials null)
- Volvo Car — Corporate Governance Report 2023 instead of Annual Report
- Wallenstam — sustainability report as primary

Potential fix: stronger negative scoring for governance/auditor documents
in `report-ranker.ts` TEXT_NEGATIVE patterns.

## 5. Investment companies have non-standard financials

Investor, Kinnevik, Bure, Industrivärden: revenue/EBIT definitions don't
map to industrial labels. Employee counts are often portfolio headcount.

Potential fix: refine `investment_company` label sets and mark EBIT as
legitimately N/A for these entities.

## 6. CEO extraction picks up headings

AstraZeneca: CEO extracted as "Changing World" (a section heading near the
CEO label). The regex matches text after "CEO" that is a heading rather
than a person's name.

Potential fix: add name-plausibility check (must contain 2+ capitalized
words, reject common heading words like "report", "world", "summary").

## 7. Stale cache files from pre-fix-round-1

Old download cache files with the `{slug}_unknown_year_annual_report.pdf`
naming (without URL hash) may still cause stale hits on re-runs. Clear
`downloads/` before the next full scrape.
