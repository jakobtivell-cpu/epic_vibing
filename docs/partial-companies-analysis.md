# Partial Companies Analysis (2026-04-12 overnight run)

Source snapshot:
- `output/results.json` (generated `2026-04-12T23:04:24.701Z`)
- `output/run_summary.json` (generated `2026-04-12T23:04:24.703Z`)

Run-level status counts:
- Complete: 59
- Partial: 46
- Failed: 5
- Timeout: 26

`complete` in this project means all four headline fields are non-null (`revenue_msek`, `ebit_msek`, `employees`, `ceo`) per `determineStatus()` in `src/pipeline.ts`.

## 1) Data-driven classification of partial rows

### Null-pattern distribution (R/E/M/C)

Legend: `R`=revenue, `E`=ebit, `M`=employees, `C`=ceo, `-`=missing.

| Pattern | Meaning | Count | Example tickers |
|---|---|---:|---|
| `R-MC` | EBIT missing | 18 | `SEB-A.ST`, `AAK.ST`, `ADDT-B.ST`, `ALIF-B.ST`, `AZA.ST` |
| `RE-C` | Employees missing | 8 | `ASSA-B.ST`, `BONEX.ST`, `EQT.ST`, `HUFV-A.ST`, `NP3.ST` |
| `---C` | only CEO present | 5 | `SAND.ST`, `INVE-A.ST`, `AQ.ST`, `KINV-A.ST`, `VOLCAR-B.ST` |
| `--MC` | only employees + CEO | 5 | `BURE.ST`, `SCA-A.ST`, `SECT-B.ST`, `ALIG.ST`, `LAGR-B.ST` |
| `R--C` | only revenue + CEO | 3 | `WALL-B.ST`, `LUG.ST`, `VIMIAN.ST` |
| `-EMC` | only EBIT + employees + CEO | 2 | `FABG.ST`, `GETI-B.ST` |
| `-E-C` | only EBIT + CEO | 2 | `INDU-A.ST`, `LUND-B.ST` |
| `--M-` | only employees | 1 | `LUMI.ST` |
| `R---` | only revenue | 1 | `ARION-SDB.ST` |
| `REM-` | only CEO missing | 1 | `BWEO.ST` |

### Partial rows by company type

| Company type | Count |
|---|---:|
| industrial | 32 |
| bank | 4 |
| investment_company | 5 |
| real_estate | 5 |

### Partial rows by source/fallback

| Dimension | Value | Count |
|---|---|---:|
| dataSource | `pdf` | 38 |
| dataSource | `playwright+pdf` | 7 |
| dataSource | `search+pdf` | 1 |
| fallbackStepReached | `cheerio` | 36 |
| fallbackStepReached | `playwright` | 7 |
| fallbackStepReached | `override` | 2 |
| fallbackStepReached | `direct-pdf-search` | 1 |

## 2) Root-cause clusters and what must be done

| Bucket | Count | Examples | What must be done to reach complete | Owner |
|---|---:|---|---|---|
| EBIT discarded by validation (`exceeds revenue` / semantic mismatch) | 16 | `SEB-A.ST`, `AAK.ST`, `AZN.ST`, `CAST.ST` | Tighten extraction line choice and units first; then selectively relax validator thresholds for `bank`/`real_estate` where line comparability differs. | Code (`src/extraction/field-extractor.ts`, `src/validation/validator.ts`) |
| EBIT not extracted | 15 | `SAND.ST`, `ADDT-B.ST`, `AQ.ST`, `LUMI.ST` | Add issuer/type-specific EBIT aliases and table strategies (especially adjusted EBIT / management metrics already used elsewhere). | Code (`src/extraction/field-extractor.ts`) |
| Revenue not extracted | 13 | `SAND.ST`, `INVE-A.ST`, `BURE.ST`, `LUND-B.ST` | Expand revenue mapping for investment/real-estate/bank variants; decide if non-industrial proxies are acceptable for assignment schema. | Code + Product |
| Employee count not extracted | 17 | `ASSA-B.ST`, `BONEX.ST`, `HUFV-A.ST`, `TEL2-A.ST` | Improve employee label detection and section targeting; add fallback extraction from sustainability/headcount sections in PDF text. | Code (`src/extraction/field-extractor.ts`) |
| Investment-company semantics (`revenue/ebit` often absent by design) | 5 | `INVE-A.ST`, `BURE.ST`, `INDU-A.ST`, `KINV-A.ST` | Product decision: either (A) map approved proxies into schema fields, or (B) keep strict semantics and accept partial for this type, or (C) introduce type-aware completion criteria. | Product + Code (`src/pipeline.ts`) |
| Missing org number prevents allabolag null-fill | 42/46 partials | many tickers without `orgNumber` | Add `orgNumber` in `data/ticker.json` for partial tickers to activate existing allabolag merge path. | Data (`data/ticker.json`) |
| Allabolag merge fired but still partial | 2 | `SEB-A.ST`, `INDU-A.ST` | Treat as extractor/validator issue (not seed issue); inspect merge notes and improve which nulls can be filled safely. | Code |
| Discovery quality / wrong-thin PDF candidates | concentrated in `cheerio` (36) | mixed | Add/refresh `annualReportPdfUrls`, `aggregatorUrls`, `cmsApiUrls`, and issuer-specific IR URLs to reduce weak PDF picks. | Data (`data/ticker.json`) |

## 3) Safe rollout strategy in build (no regression of current completes)

This must be part of implementation and CI/release gating.

### Phase order (low risk -> high risk)

1. Phase A (data only): `data/ticker.json` seed improvements (`orgNumber`, `annualReportPdfUrls`, `irPage`, `aggregatorUrls`, `cmsApiUrls`).
2. Phase B (extraction): issuer-scoped extraction improvements in `src/extraction/field-extractor.ts`.
3. Phase C (validation/semantics): selective validator updates in `src/validation/validator.ts`; completion-rule/product changes in `src/pipeline.ts` only after explicit decision.

### Required gates per phase

1. Unit/integration tests:
   - `tests/ebit-extraction-strategies.test.ts`
   - `tests/bank-extraction.test.ts`
   - `tests/validator-reporting-model.test.ts`
2. Canary rerun diff against baseline `complete` rows from current `output/results.json`:
   - no `complete -> partial/failed/timeout`
   - no non-null headline field becomes null
   - numeric drift alert when `abs(delta_pct) > 30%` unless approved
3. Only after canary passes, run full overnight batch and apply same diff checks.

### Canary set (heuristic-sensitive current completes)

Current complete rows that depend on sensitive heuristics (unit guards, EUR conversion, real-estate proxy EBIT, adjusted EBIT):

`VOLV-A.ST`, `ERIC-A.ST`, `ATCO-A.ST`, `ESSITY-A.ST`, `TELIA.ST`, `ATRLJ-B.ST`, `BILL.ST`, `CATE.ST`, `CLAS-B.ST`, `EPI-A.ST`, `EVO.ST`, `HOLM-A.ST`, `HUSQ-A.ST`, `NDA-SE.ST`, `NOLA-B.ST`, `PNDX-B.ST`, `SAAB-B.ST`, `SECU-B.ST`, `SSAB-A.ST`, `THULE.ST`, `TREL-B.ST`, `WIHL.ST`, `8TRA.ST`, `BUFAB.ST`, `INTEA-B.ST`, `KOGO.ST`, `MTRS.ST`, `SHOT.ST`, `SKIS-B.ST`.

### Rollback posture

- Keep each phase in separate commits.
- If regression appears, revert only the current phase and continue with lower-risk phases.

## 4) Recommended implementation sequence

1. Data pass: fill `orgNumber` for highest-impact partial tickers first, then add/refresh PDF overrides for stubborn `cheerio` partials.
2. Extractor pass: target top two buckets (`R-MC` and `RE-C`) to recover EBIT and employee fields.
3. Validator pass: only after extraction gains are measured; keep changes type-aware and narrowly scoped.
4. Product decision checkpoint: decide whether investment-company rows should be allowed to become `complete` via type-specific criteria or proxy mapping.
