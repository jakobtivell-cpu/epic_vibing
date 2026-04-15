# Iteration 4
- Target: Betsson AB (publ) / ebit_msek
- Root cause: OCR-collapsed decimal sequences allowed synthetic fallback tokens to be parsed as large EBIT values.
- Code change: Tightened fallback token regex boundaries in field extraction so embedded numbers inside collapsed decimal runs are ignored instead of treated as valid financial cells.
- Verification: logic confirmed via cached text (`cache/betsson_ab_publ-2025.txt`) and wrapper type-check (`node scripts/run-wrapped.cjs "npx tsc --noEmit --pretty false"`).
- Files changed: src/extraction/field-extractor.ts
- Completeness: 0.7318840579710145 (101/138) - awaiting next scrape cycle
