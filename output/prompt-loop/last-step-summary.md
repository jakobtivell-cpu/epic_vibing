# Iteration 6
- Target: HMS Networks AB (publ) / ebit_msek
- Root cause: Narrative "impact on operating profit" lines were allowed into EBIT matching and could be selected instead of the true line item.
- Code change: Added EBIT exclusion patterns for narrative impact-on-operating-profit wording so sensitivity/FX commentary numbers are ignored during EBIT extraction.
- Verification: logic confirmed via cached text (`cache/hms_networks_ab_publ-2025.txt`) and wrapper type-check (`node scripts/run-wrapped.cjs "npx tsc --noEmit --pretty false"`).
- Files changed: src/extraction/field-extractor.ts
- Completeness: 0.7318840579710145 (101/138) - awaiting next scrape cycle
