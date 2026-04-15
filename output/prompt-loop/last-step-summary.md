# Iteration 9
- Target: Nordnet AB (publ) / employees
- Root cause: OCR-concatenated employee columns were parsed as a single inflated number and then discarded as implausible.
- Code change: Added employee-specific normalization for 6/9-digit concatenated multi-year column strings, taking the first 3-digit group when inflated values indicate OCR column concatenation.
- Verification: logic confirmed via cached text (`cache/nordnet_ab_publ-2026.txt`) and wrapper type-check (`node scripts/run-wrapped.cjs "npx tsc --noEmit --pretty false"`).
- Files changed: src/extraction/field-extractor.ts
- Completeness: 0.7318840579710145 (101/138) - awaiting next scrape cycle
