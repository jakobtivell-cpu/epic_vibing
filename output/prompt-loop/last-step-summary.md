# Iteration 12
- Target: Avanza Bank Holding AB (publ) / ebit_msek
- Root cause: Bank revenue label matching missed "R?relsens int?kter" wording, causing under-picked revenue-equivalent lines that can invalidate otherwise-correct bank EBIT mapping.
- Code change: Extended bank primary revenue labels with "r?relsens int?kter" variants and "operating income" to prioritize consolidated operating-income rows over narrow sub-lines.
- Verification: logic confirmed via cached text (`cache/avanza_bank_holding_ab_publ-2025.txt`) and wrapper type-check (`node scripts/run-wrapped.cjs "npx tsc --noEmit --pretty false"`).
- Files changed: src/extraction/labels.ts
- Completeness: 0.7318840579710145 (101/138) - awaiting next scrape cycle
