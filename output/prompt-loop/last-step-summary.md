# Iteration 7
- Target: Bonesupport Holding AB (publ) / employees
- Root cause: Employee extraction missed narrative sentence formats where employee count precedes the label keyword.
- Code change: Added narrative employee fallback patterns (for "the Group had ... employees" and "average number of employees") and applied this fallback when labeled table extraction returns no match.
- Verification: logic confirmed via cached text (`cache/bonesupport_holding_ab_publ-2025.txt`) and wrapper type-check (`node scripts/run-wrapped.cjs "npx tsc --noEmit --pretty false"`).
- Files changed: src/extraction/field-extractor.ts
- Completeness: 0.7318840579710145 (101/138) - awaiting next scrape cycle
