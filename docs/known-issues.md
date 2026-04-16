# Known Issues — Full Scrape Analysis (2026-04-16, post-fix-round-4)

Fresh diagnosis from `output/results.json` + `output/run_summary.json` (136
companies: 88 complete, 23 partial, 3 failed, 22 timeout). Per-field null
counts in the last run: `fiscal_year` 38, `ebit`/`employees` 36, `revenue` 34,
`ceo` 27.

## Fix round 4 (this run)

**Fixed**

- **`fiscal_year` null despite good revenue** — Ten tickers had only “Fiscal year
  not found…” in notes (e.g. period-end wording lives with the income statement,
  past the 15k-char early window). Added a deep, anchor-only scan (English/Swedish
  closing-date phrases + integrated report title) in `findFiscalYear`.
- **False EUR unit context (Holmen-class)** — Early `MEUR` in footnotes won over
  later “Amounts in SEK m” on the consolidated statements. `detectUnitContext`
  now prefers explicit body SEK-millions wording when the EUR hit is still in
  the front matter.

**Skipped (same scrape JSON; no new clusters ≥3 with a better tractable fix)**

- **Industrial mid-band KSEK-as-MSEK** (e.g. Camurus) — still needs joint
  context, not a lower global industrial threshold.
- **Pipeline timeouts (22)**, **Arion ISK**, **wrong PDF first** (Sandvik / Volvo
  Car / Wallenstam), **Wihlborgs employee OCR concat**, **partial EBIT on
  holdings** — unchanged; see sections below.

**Human loop note:** If two consecutive fix rounds produce no code commits, stop
the prompt loop and refresh data (e.g. new scrape) before continuing.

## Fix round 3 (historical)

**Fixed**

- **Real-estate KSEK lines tagged as MSEK** — Atrium Ljungberg, Cibus Nordic,
  Wihlborgs (and similar): revenue sat in the hundreds of thousands to low
  millions MSEK while the megascale guard used a 5M floor for `real_estate`, so
  ÷1000 never ran. Threshold is now ~tens of thousands MSEK (`number-guards.ts`).
  EBIT for cases like Cibus should follow via the existing EBIT-vs-revenue
  megascale guard after revenue is corrected.
- **CEO = section heading / boilerplate / legal-name echo** — Multiple Large
  Cap rows had two-token “names” such as report headings, US filing phrases, or
  the issuer name repeated beside the CEO label (`field-extractor.ts`).

**Skipped (tractable later or needs re-scrape to confirm)**

- **Industrial mid-band KSEK-as-MSEK** (e.g. Camurus ~532k MSEK with plausible
  mega-cap magnitude) — same order of magnitude as genuine Volvo-class revenues;
  needs a safer joint signal (snippet units, segment table, etc.), not a lower
  industrial threshold alone.
- **Pipeline timeouts (22)** — operational / override / timeout budget, not
  addressed here.
- **Arion ISK**, **wrong PDF ranked first** (Sandvik / Volvo Car / Wallenstam),
  **Wihlborgs employee OCR concat** — still listed in sections 2–5 below.

---

Additional failure patterns from earlier analysis. Items marked ✅ were
addressed in fix rounds 1–4 where noted; unmarked items are NOT fully fixed.

## 1. Pipeline timeouts (22/136 companies — 16.2%)

Companies timing out at 210s: ABB, Electrolux, Ericsson, Handelsbanken,
Swedbank, DNB, Stora Enso, Saab, NIBE, Sinch, and others.

Root causes: complex JS-heavy IR pages exhausting Playwright budget, deep
sub-page crawl + fallback ladder consuming the timeout, or IR page not
discovered at all.

Potential fix: curate `irPage`/`annualReportPdfUrls` overrides in
`data/ticker.json` for the 22 timeout companies, or increase per-company
timeout for known-slow sites.

## 2. KSEK/wrong-scale revenue (inflated by 100x–1000x)

Several companies have revenue values 100x–1000x too large, suggesting
the extractor read KSEK or TSEK values without downscaling to MSEK:

| Company | Revenue (MSEK) | Expected ~MSEK | Employees |
| --- | --- | --- | --- |
| Atrium Ljungberg | 2,988,000 | ~3,000 | 111 |
| Wihlborgs | 4,354,000 | ~4,350 | 156,152 (also wrong) |
| Camurus | 532,265 | ~532 | null |
| Cibus Nordic | 731,621 | ~732 | null |

✅ **Landlord / `real_estate` typed rows:** megascale threshold lowered so the
above Atrium / Cibus / Wihlborgs pattern is corrected (fix round 3).

**Still open:** industrial-scale picks in the ~500k–3M MSEK band (e.g. Camurus)
where ÷1000 is wrong for true mega-caps — needs stronger context than a global
threshold; also Wihlborgs employee column concatenation is separate.

## 3. False EUR detection (Holmen AB)

Holmen is a Swedish company reporting in SEK, but `detectUnitContext` matched
an EUR pattern early in the document (possibly from a footnote about EUR-
denominated debt). Revenue was then multiplied by 11.25, inflating from
~15,400 → 173,554 MSEK.

✅ **Addressed (fix round 4):** when the winning EUR marker sits in the first
~45k chars and explicit “Amounts in SEK m” / `belopp i msek` appears later in
the body, unit context falls back to MSEK. Needs a fresh scrape to confirm on
`HOLM-A.ST` row.

## 4. Wrong document type selected

- Sandvik — auditors' remuneration PDF (no P&L, all financials null, emp=600)
- Volvo Car — Corporate Governance Report instead of Annual Report
- Wallenstam — sustainability report as primary

Potential fix: stronger negative scoring for governance/auditor documents
in `report-ranker.ts` TEXT_NEGATIVE patterns.

## 5. Investment companies have non-standard financials

Investor (rev=682,517), Kinnevik, Bure, Industrivärden: revenue/EBIT
definitions don't map to industrial labels. Employee counts are often
portfolio headcount, not operating headcount.

Potential fix: refine `investment_company` label sets and mark EBIT as
legitimately N/A for these entities.

## 6. CEO extraction picks up headings

AstraZeneca: CEO extracted as "Changing World" (a section heading near the
CEO label). The regex matches text after "CEO" that is a heading rather
than a person's name.

✅ **Partially addressed (fix round 3):** discard known heading/boilerplate
substrings and CEO candidates that are only a subset of the legal company name
(e.g. issuer repeated next to the title). Residual false positives may still
need token-shape heuristics for edge cases.

## 7. Stale cache files from pre-fix-round-1

Old download cache files with the `{slug}_unknown_year_annual_report.pdf`
naming (without URL hash) may still cause stale hits on re-runs. Clear
`downloads/` before the next full scrape.

## 8. ✅ Report ranker selecting old reports (Bug 1 — fixed)

Atlas Copco previously selected a 1999 report. Fixed by:
- Expanding `extractYear` regex to match 19xx years
- Adding `yearScore()` with +50pts for current/prior year, -30pts for >2yr old
- Applying `yearScore` to URL-based year detection in `urlScore()`
- Pre-filtering stale candidates via `candidateUrlsOrTextImpliesStaleReport`

## 9. ✅ Download cache key collision (Bug 2 — fixed)

Multiple PDF candidates from the same company cached to the same file when
year was unknown. Fixed by including `urlHash8(url)` in the cache filename.

## 10. ✅ Non-SEK currency: IFRS income statement heading (Bug 3 — fixed)

AstraZeneca (USD reporter) had unconverted revenue=58,739, EBIT=14,
employees=1,979 (actual: ~$58.7B revenue, ~90K employees).

Root cause: `INCOME_STATEMENT_PATTERNS` did not match "Consolidated
Statement of Comprehensive Income" (standard IFRS heading). The income
statement section went undetected, so revenue/EBIT were extracted from
summary sections without proper `$m` unit context.

Fixed by:
- Adding `comprehensive income` patterns to `INCOME_STATEMENT_PATTERNS`
- Replacing `comprehensive income` boundary with `other comprehensive income`
- Section boundary now also stops at adjacent IS headings
- `findNarrativeEmployeeHit` returns the LARGEST plausible match (not first)
- Added patterns: `N employees (YYYY:)`, `workforce of N`

## 11. Partial extraction — EBIT commonly missing

8 partial companies have revenue but null EBIT: AddLife, Alimak, Betsson,
Bure, Höegh, Investor, Kinnevik, Lundin Mining. Some may be genuine
(investment companies), others may need additional EBIT label patterns or
tolerance for OCR-fused numbers (e.g. "13,74 3" for AstraZeneca-style spacing).

## 12. Arion banki — ISK currency not handled

Arion banki reports in Icelandic króna (ISK). Revenue=1,746 and EBIT=2,370
are ISK billions (~18 BSEK and ~25 BSEK respectively). No ISK detection
or conversion exists.

Potential fix: add `isk_m` / `isk_bn` to `UnitContext` with ISK→SEK rate ~0.075.
