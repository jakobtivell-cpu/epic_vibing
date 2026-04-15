# Iteration 5
- Target: Svenska Cellulosa Aktiebolaget SCA (publ) / revenue_msek
- Root cause: Revenue fallback matched only billion/BSEK narrative patterns and missed clear MSEK wording.
- Code change: Added narrative MSEK revenue patterns (for "net sales/revenue amounted to SEK <value>m") so consolidated revenue can be recovered when table OCR is unreliable.
- Verification: logic confirmed via cached text (`cache/svenska_cellulosa_aktiebolaget_sca_publ-2025.txt`) and wrapper type-check (`node scripts/run-wrapped.cjs "npx tsc --noEmit --pretty false"`).
- Files changed: src/extraction/field-extractor.ts
- Completeness: 0.7318840579710145 (101/138) - awaiting next scrape cycle
