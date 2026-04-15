# Iteration 2
- Target: Beijer Ref AB (publ) / ebit_msek
- Root cause: OCR-collapsed two-year KSEK EBIT rows were parsed as one inflated MSEK value, and single-space year headers were not reliably recognized.
- Code change: Updated year-header parsing to capture year tokens from single-space headers and expanded EBIT megascale guard to downscale 1000x-inflated values when revenue-relative plausibility indicates a KSEK->MSEK unit mismatch.
- Verification: logic confirmed via cached text (`cache/beijer_ref_ab_publ-unknown_year.txt`) and wrapper type-check (`node scripts/run-wrapped.cjs "npx tsc --noEmit --pretty false"`).
- Files changed: src/extraction/field-extractor.ts
- Completeness: 0.7318840579710145 (101/138) - awaiting next scrape cycle
