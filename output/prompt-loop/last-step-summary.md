# Iteration 10
- Target: Kinnevik AB / revenue_msek
- Root cause: Investment revenue extraction lacked labels for "other operating income" style wording used in some investment-company annual reports.
- Code change: Added "other operating income" and "ovriga rorelseintakter" to investment-company revenue labels so these revenue-equivalent lines can be matched.
- Verification: logic confirmed via cached text (`cache/kinnevik_ab-2025.txt`) and wrapper type-check (`node scripts/run-wrapped.cjs "npx tsc --noEmit --pretty false"`).
- Files changed: src/extraction/labels.ts
- Completeness: 0.7318840579710145 (101/138) - awaiting next scrape cycle
