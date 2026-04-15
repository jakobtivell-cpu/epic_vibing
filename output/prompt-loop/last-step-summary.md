# Iteration 3
- Target: Bure Equity AB (publ) / revenue_msek
- Root cause: Revenue parsing was skipped for investment-company profiles, so valid investment-income labels were ignored.
- Code change: Added investment-focused revenue labels (including "intakter fran investeringsverksamheten" and "summa intakter") and enabled normal revenue extraction flow for investment_company with a low minimum threshold.
- Verification: logic confirmed via cached text (`cache/bure_equity_ab_publ-2024.txt`) and wrapper type-check (`node scripts/run-wrapped.cjs "npx tsc --noEmit --pretty false"`).
- Files changed: src/extraction/field-extractor.ts, src/extraction/labels.ts
- Completeness: 0.7318840579710145 (101/138) - awaiting next scrape cycle
