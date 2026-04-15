# Known Issues — Full Scrape Analysis (2026-04-15)

Additional failure patterns identified from `output/results.json` (136 companies,
54 complete / 15 partial / 67 timeout). These are NOT yet fixed.

## 1. Pipeline timeouts (67/136 companies)

Half the companies timed out at 180s before reaching extraction. Root causes vary:
- IR page not discovered (no `irPage` in results)
- IR page discovered but sub-page crawl + fallback ladder exhausted the budget
- Playwright fallback triggered but slow on JS-heavy IR sites

Potential fix: increase per-company timeout, parallelize discovery steps, or
add curated `irPage`/`annualReportPdfUrls` overrides in `data/ticker.json`.

## 2. Wrong document type selected

Several companies got governance, sustainability, or auditor reports instead of
the full annual report:
- Sandvik — auditors' remuneration PDF (no P&L, all financials null)
- Volvo Car — Corporate Governance Report 2023
- Wallenstam — sustainability report as primary
- Lindab — sustainability PDF URL but financials still extracted

Potential fix: stronger negative scoring for "governance", "sustainability-only",
and "auditor" documents in `report-ranker.ts` TEXT_NEGATIVE patterns.

## 3. Investment companies have non-standard financials

Investor, Kinnevik, Bure, Industrivärden: revenue/EBIT definitions don't map
cleanly to industrial labels. Employees are often discarded as "portfolio headcount".

Potential fix: refine `investment_company` label sets and loosen employee thresholds
for this company type.

## 4. Fiscal year misread as employee count

Some companies have employee values that match a fiscal year (e.g. 2025, 2024).
The existing `isFiscalYearMisreadAsEmployees` guard catches some but not all cases.

## 5. CEO extraction picks up headings

AstraZeneca: CEO extracted as "Changing World" (a section heading). The CEO finder
regex sometimes matches text after "VD" or "CEO" labels that is a heading rather
than a person's name.

Potential fix: add a name-plausibility check (must contain at least two capitalized
words, no common heading words like "report", "world", "summary").

## 6. Revenue from calendar-year bleed

Lundin Mining: revenue extracted as 2025 (the calendar year leaked into the revenue
field from a year column). The fused-year guard didn't catch single-year values.

## 7. Stale cache entries from unknown_year collisions

Fixed in this round (Bug 2), but existing `downloads/` cache files with the old
`{slug}_unknown_year_annual_report.pdf` naming may still cause stale hits on re-runs.
Consider clearing `downloads/` before the next full scrape.
