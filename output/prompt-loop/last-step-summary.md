# Iteration 11
- Target: Camurus AB (publ) / employees
- Root cause: Employee narrative parsing did not cover "number of employees increased from X to Y" wording used in annual reports.
- Code change: Added English and Swedish narrative employee patterns that capture the post-increase headcount value in "increased/okade fran ... to/till ..." sentences.
- Verification: logic confirmed via cached text (`cache/camurus_ab_publ-2024.txt`) and wrapper type-check (`node scripts/run-wrapped.cjs "npx tsc --noEmit --pretty false"`).
- Files changed: src/extraction/field-extractor.ts
- Completeness: 0.7318840579710145 (101/138) - awaiting next scrape cycle
