# Known Issues — Full Scrape Analysis (2026-04-16, post-fix-round-13)

## Fix round 14 — artifact mismatch, exit

`run_summary.json` (2026-04-16T08:49:45.874Z, 48 companies) does not match `results.json` (136 rows from 2026-04-15 scrape) — regenerate both from a single full run before the next fix round.

Fresh diagnosis from `output/results.json` + `output/run_summary.json` (136
companies: 88 complete, 23 partial, 3 failed, 22 timeout). Per-field null
counts in the last run: `fiscal_year` 38, `ebit`/`employees` 36, `revenue` 34,
`ceo` 27.

## Fix round 13 (this run)

**Diagnosis (same scrape JSON, timestamp 2026-04-15)** — Among `complete` rows,
**five** still had **non-person** `ceo` strings. Four phrases were already in
`CEO_HEADING_OR_BOILERPLATE_SUBSTRINGS` on `main` (stale scrape vs those commits).
**`Chief Human Resources`** (e.g. VSURE) was a **remaining** false positive:
adjacent **HR org title** after the CEO heading, not a person name.

**Fixed**

- **CEO: reject “Chief Human Resources”** — Added substring + test (`field-extractor.ts`,
  `ceo-extraction-context.test.ts`).

**Skipped**

- **Larger ≥3 clusters** (timeouts, stale fiscal/EBIT/revenue gates, investment EBIT,
  etc.) — unchanged until **re-scrape**; no duplicate generic pass on this JSON alone.

**Hypotheses needing a fresh scrape:** whether VSURE-class rows clear; full
matrix validation for rounds 6–9 + 13 together.

**Human loop note:** This round shipped a **code** commit after three docs-only
rounds — continue iterative hunts after a **new** `results.json`, or the loop
risks re-treading stale symptoms.

---

## STOP — re-scrape recommended

**`output/results.json` is still the 2026-04-15 run.** Most null/failure buckets
predate merged extractor/validator fixes (rounds 6–12). **Regenerate results on
current `main`** before treating remaining counts as authoritative.

---

## Fix round 12 (historical — documentation only)

**Diagnosis** — `run_summary.json` timestamp is still **2026-04-15**; failure
counts and clusters match prior triage. No **new** ≥3-company pattern appears that
is both **not already covered on `main`** (rounds 6–9) and **safe to fix in one
commit** without a refreshed `results.json`.

**Fixed (this round)** — *No code changes.*

**Skipped** — Same as rounds 10–11 (stale JSON vs merged fixes; heterogeneous
leftovers; investment EBIT ×3 with mixed causes; CEO “Chief Human Resources” ×1
below cluster threshold per prompt rules).

**Hypotheses needing a fresh scrape:** unchanged — regenerate `output/results.json`
on current `main` before the next code fix round.

---

## Fix round 11 (historical — documentation only)

**Diagnosis (same scrape JSON)** — Same landscape as round 10. Examples: **five**
`complete` rows still show **non-person** `ceo` strings (“Changing World”, “Exchange
Act Rule”, “Joined Pandox”, “Securitas Values”, “Chief Human Resources”); **four**
of those phrases are already in `CEO_HEADING_OR_BOILERPLATE_SUBSTRINGS` on
`main` — the file is almost certainly **older than those commits**. **One**
remaining gap at substring level is **Chief Human Resources** (1 ticker) — **below
the ≥3 threshold** for a data-driven cluster this prompt. **Investment_company**
with revenue but **null EBIT** appears **three** times; root causes differ
(portfolio exclusion vs no line match) and a one-commit “fix” risks wrong
assignments.

**Fixed (this round)** — *No code changes.*

**Skipped** — Same as round 10; no new ≥3 cluster with a single safe mechanism
that is not already merged or long-tail.

**Hypotheses needing a fresh scrape:** all prior merged fixes (rounds 6–9) vs
current `main`; whether a **new** ≥3 cluster appears after refresh.

## Fix round 10 (historical — documentation only)

**Diagnosis (same scrape JSON)** — Re-checked clusters vs **git history (through
fix round 9)**. Large note-buckets still include: **“below 1,000 — implausible”**
(8), **“Fiscal year not found”** (13), **Second-pass EBIT** (15), **“EBIT not
found”** (14), **“CEO not found”** (3), **timeouts** (22), etc. Most align with
**already merged** fixes (industrial revenue floor, fiscal-year anchors,
investment-company employees, EBIT/IS windows, CEO boilerplate substrings, M&A URL
penalties, …) on **`results.json` that predates those commits**.

**Fixed (this round)** — *No code changes.* Shipping another generic extractor
pass without a **fresh scrape** would duplicate logic already on `main` or chase
**heterogeneous** leftovers (e.g. **CEO not found** ×3 = bank ISK / mining USD /
wrong Sandvik doc — not one mechanism).

**Skipped / deferred**

- **All tractable ≥3 clusters** visible in this JSON are either **covered by
  rounds 6–9** (pending re-scrape confirmation) or **not one root cause** across
  the tickers (second-pass / EBIT-not-found mixes partials and completes).
- **Long-tail** <3 companies per pattern (e.g. residual role-adjacent CEO
  captures) — not worth a blind rule without new evidence.

**Hypotheses needing a fresh scrape:** which note buckets actually clear after
re-running the pipeline on `main`; whether any **new** ≥3 cluster appears with a
single owner file.

**Human loop note:** **This round shipped no code commits.** If the **next** fix
round also ships **no code**, stop the iterative prompt loop and **re-scrape**
before another generic hunt (per guardrails).

## Fix round 9 (historical)

**Diagnosis (same scrape JSON)** — **Eight** rows hit the validator line **“Revenue …
MSEK below 1,000 — implausible for Large Cap industrial”** (industrial gate).
Several show **mid-hundreds** “MSEK” net sales with **thousands of employees** and
**healthy EBIT/revenue on that same mis-scaled pair** (e.g. hygiene / equipment
names), consistent with a **×1000** unit error before the 1k floor. Others are
wrong-doc, mining, mis-typed RE, or inconsistent EBIT/employee rows where a
blind ×1000 would misfire.

**Fixed**

- **Industrial sub–1k revenue recovery** — When revenue is in **[100, 999]**, employees
  **≥ 5k**, revenue/employee **< 0.03 MSEK/FTE**, and operating margin on the
  **extracted** pair is **8–45%**, apply **×1000** with a warning instead of
  nulling (`validator.ts`). Targets the hygiene/equipment-style cluster; **low
  margin on the micro pair** skips landlord / wrong-line cases in the same gate.

**Skipped**

- **Rows where revenue, EBIT, and employees are jointly wrong** (e.g. Getinge-class
  headcount), **wrong PDF / governance**, **timeouts**, **industrial EBIT-only
  partials (5)** — still need re-scrape or bespoke extraction; not the same
  gate pattern.
- **Post-recovery EBIT** may still be on the wrong scale even when revenue
  recovers — confirm on a fresh scrape.

**Hypotheses needing a fresh scrape:** whether Essity-class rows gain plausible
`revenue_msek` without new false positives; whether Nyfosa-class stays null as
intended.

**Human loop note:** This round shipped a code commit. If **two consecutive**
future fix rounds ship **no** commits, stop and re-scrape before continuing.

## Fix round 8 (historical)

**Diagnosis (same scrape JSON)** — Among rows with `extractedData`, **nine** had
`employees` null while `revenue_msek` was set. **Four** are
`investment_company` (Industrivärden, Investor, Kinnevik, Lundberg): notes show
labeled headcounts (e.g. 3k–8k) **discarded** as “portfolio/holdings” — a
systematic null pattern. Other employee-null rows (Camurus, Cibus, Wallenstam,
Arion, Lundin Mining) mix extraction / doc-type / ISK issues (not one shared
root cause ≥3).

**Fixed**

- **Investment company: keep large labeled employee counts** — Portfolio /
  consolidated FTE is still the only labeled figure in many annual reports;
  retain it with an explicit “not industrial operating FTE” note instead of
  forcing null (`field-extractor.ts`).
- **Income statement window + EBIT megascale handoff** — Sections shorter than
  five lines but ending at EOF (snippets / tests) were dropped entirely; and
  primaries rejected as “above revenue” sometimes sat in the band where
  `applyEbitMegascaleGuard` would ÷1000 to a plausible EBIT — those now reach
  the standard unit-guard path (`field-extractor.ts`).

**Skipped**

- **Timeouts / failed**, **Camurus / Wallenstam / Arion / Lundin Mining
  employee gaps**, **industrial EBIT null (5 in JSON)** — prior rounds + need
  re-scrape or bespoke work; not the investment-company discard pattern.
- **Camurus-scale KSEK revenue**, **ISK**, **wrong PDF first** — unchanged.

**Hypotheses needing a fresh scrape:** whether the four investment/holding rows
gain non-null `employees` without harming downstream plausibility checks;
whether short-IS PDFs pick up EBIT more often.

**Human loop note:** This round shipped code commits. If **two consecutive**
future fix rounds ship **no** commits, stop and re-scrape before continuing.

## Fix round 7 (historical)

**Diagnosis (same scrape JSON)** — Of 38 `fiscal_year` nulls, 25 are timeouts /
failed with no `extractedData`. The remaining **13** share “Fiscal year not
found…” notes while other fields look populated (9 `complete`, 4 `partial`):
cover/statement phrasing not covered by the round-4 anchor set.

**Fixed**

- **Fiscal year — extra title and period-end phrasing** — Leading-year cover
  lines (`2024 Annual … report`), `annual report for YYYY`, `year-end report`,
  optional **“financial”** before **“year ended”**, US order **December 31,
  YYYY** (and June/September 30 variants), Swedish **“räkenskapsåret som
  avslutades …”**, and **ISO `YYYY-12-31`** after räkenskapsår (`field-extractor.ts`
  `findFiscalYear`).

**Skipped**

- **Timeouts / failed (25 rows)** — no extraction to patch in code this way.
- **Industrial EBIT null (5)**, **investment_company EBIT null (3)** — prior
  rounds already targeted; stale JSON still shows pre-fix symptoms until a new
  scrape.
- **Camurus-scale KSEK**, **Arion ISK**, **wrong-doc first PDF**, **Wihlborgs
  OCR** — unchanged; see sections below.

**Hypotheses needing a fresh scrape:** whether Atrium / Attendo / Axfood / Clas
Ohlson / EQT / Hexagon / MTG / Scandic / Systemair (and partial Beijer / Cibus /
Sandvik / Volvo Car) pick up `fiscal_year` without new false years on TOC/MD&A
noise.

**Human loop note:** This round shipped a code commit. If the next fix round
ships none, and the one after that also ships none, stop and re-scrape before
continuing.

## Fix round 6 (historical)

**Fixed**

- **Industrial EBIT slightly above net sales discarded in validation** — IFRS /
  line-definition mismatches can leave EBIT a few percent (or up to ~15% with a
  small absolute gap) above extracted net sales; validator now keeps a tight
  near-parity band instead of nulling EBIT (`validator.ts`). Targets partial-row
  cluster (e.g. AddLife / Betsson scale in the last JSON).
- **Industrial primary operating line KSEK read as MSEK** — Huge “EBIT” vs
  credible revenue: widen the non-bank EBIT search ceiling for sub–100k MSEK
  revenue so the bad cell is still selected, then one-shot ÷1000 recovery when
  the primary candidate is implausible vs revenue (`field-extractor.ts`).
  Targets Höegh-class rows in the last JSON.
- **Bank: operating result vs very low revenue-equivalent** — When the revenue
  proxy is under 10k MSEK, do not treat EBIT > revenue as an automatic discard;
  the proxy is often not comparable to operating profit (`validator.ts`). Needs
  a fresh scrape to confirm against live bank rows.

**Skipped (unchanged scrape JSON; larger or bespoke work)**

- **Timeouts (22)**, **industrial Camurus-scale KSEK** (joint context), **Arion
  ISK**, **wrong PDF first** (Volvo Car / Wallenstam), **Wihlborgs employee
  OCR**, **holdings / investment_company partial EBIT** — same as prior rounds;
  see sections below.

**Hypotheses needing a fresh scrape:** whether AddLife / Betsson / Höegh (and
similar) move from partial to complete after validation + EBIT recovery; whether
the bank branch removes false nulls without introducing bad assignments.

**Human loop note:** This round shipped code commits. If the *next* run also
ships commits, continue; if **two consecutive** fix rounds produce **no** code
commits, stop the prompt loop and refresh data before continuing.

## Fix round 5 (historical)

**Fixed**

- **Orphan tiny `ebit_msek` with no revenue** — Several partial rows (e.g.
  Essity, Electrolux Professional, Nyfosa, Getinge-class) had null revenue but
  EBIT in the single- or low-double-digit MSEK while employees were in the
  thousands — implausible operating result vs headcount. Discarded in
  `extractFields` via `shouldDiscardOrphanEbitVersusHeadcount` (`field-extractor.ts`).
- **M&A / acquisition presentation PDFs ranked as annual report** — Sandvik’s
  URL path contained a typo `acqusition-presentations` / deck-style `presentation`
  file; when no `annual_like` candidate exists, the fallback pool must not prefer
  that PDF. Added `TEXT_NEGATIVE` + `urlScore` penalties and `acq[u]?isition` in
  non-annual classification (`report-ranker.ts`).

**Skipped (still visible in stale JSON or need re-scrape / bespoke work)**

- **Industrial Camurus-scale KSEK**, **timeouts (22)**, **Arion ISK**, **Volvo Car /
  Wallenstam wrong doc**, **Wihlborgs employee OCR**, **holdings partial EBIT** —
  not fully addressed this round; see numbered sections below.

**Human loop note:** If two consecutive fix rounds produce no code commits, stop
the prompt loop and refresh data (e.g. new scrape) before continuing.

## Fix round 4 (historical)

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
addressed in fix rounds 1–5 where noted; unmarked items are NOT fully fixed.

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

- Sandvik — in the last run, an acquisition/M&A **presentation** PDF was chosen
  (not the consolidated annual report; financials null, spurious `emp=600`).
- Volvo Car — Corporate Governance Report instead of Annual Report
- Wallenstam — sustainability report as primary

✅ **Partially addressed (fix round 5):** extra penalties for acquisition-deck URL
paths (including common `acqusition` typo) in `report-ranker.ts`. Volvo Car /
Wallenstam still need stronger governance/sustainability deprioritization or
better primary PDF discovery.

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

✅ **Partially addressed (fix round 6):** validator near-parity keep for industrial
EBIT vs net sales; primary EBIT ÷1000 + industrial search slop for KSEK-as-MSEK
on the operating line — **re-scrape needed** to confirm AddLife / Betsson /
Höegh / Alimak-class rows.

## 12. Arion banki — ISK currency not handled

Arion banki reports in Icelandic króna (ISK). Revenue=1,746 and EBIT=2,370
are ISK billions (~18 BSEK and ~25 BSEK respectively). No ISK detection
or conversion exists.

Potential fix: add `isk_m` / `isk_bn` to `UnitContext` with ISK→SEK rate ~0.075.
