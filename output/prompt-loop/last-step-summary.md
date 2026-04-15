# Iteration 8
- Target: AB Industrivarden (publ) / revenue_msek
- Root cause: Revenue extraction could stop after one fused-year artifact candidate instead of evaluating alternate labeled rows.
- Code change: Added alternate revenue-candidate retry logic after fused-year rejection, selecting the first non-fused labeled revenue match from a broader pool.
- Verification: logic confirmed via cached text (`cache/ab_industriv_rden_publ-2024.txt`) and wrapper type-check (`node scripts/run-wrapped.cjs "npx tsc --noEmit --pretty false"`).
- Files changed: src/extraction/field-extractor.ts
- Completeness: 0.7318840579710145 (101/138) - awaiting next scrape cycle
