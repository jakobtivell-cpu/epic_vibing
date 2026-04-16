# Iterative fix round — copy-paste operator prompt

Paste the block below into the model **once per fix round**. This prompt is **markdown-first** (not JSON handoff). It pairs with the JSON-centric templates in [prompt-templates.md](./prompt-templates.md) when you need structured handoff instead.

---

## Prompt (copy from here)

### Iterative Fix Round — Swedish Large Cap Scraper

You are improving the scraper toward 100% row success. Your job is to **ship code changes**. Running the scraper is allowed when needed to validate fixes or refresh artifacts. Verify with `npx tsc --noEmit` and commit per fix.

A **successful** round ends with at least one `fix:` commit. Ending a round with only `docs:` commits means something blocked you — name the blocker explicitly so the human can unblock it.

*Repo note:* [`output/run_summary.json`](../../output/run_summary.json) uses `companiesProcessed` for total row count, top-level `complete` / `partial` / `failed` / `timedOut` for status counts (no nested `counts` object). `nullFields` and `durationMs` may be absent — derive nulls from `npm run analyze:quality`.

### Step 0 — Read the current state

1. Read `output/run_summary.json` and `output/results.json`. Note timestamp, row count, status distribution, and per-field null counts. If they disagree (e.g. `companiesProcessed: 48` but `results.json` has 136 rows), **treat `results.json` as the source of truth** and note the discrepancy in your final summary — **do not halt**.
2. Read [`docs/known-issues.md`](../../docs/known-issues.md) and run `git log --oneline -50`. Build a registry of what's been fixed so you don't repeat it.

### Step 1 — Diagnose

1. Run `npm run analyze:quality` (uses [`scripts/analyze-results-quality.cjs`](../../scripts/analyze-results-quality.cjs)).
2. **Row success:** `status === "complete"` **and** all five fields (`revenue_msek`, `ebit_msek`, `employees`, `ceo`, `fiscal_year`) non-null in `extractedData`. **Quality failures** — `complete` rows with bogus values (wrong CEO strings, orders-of-magnitude wrong revenue, absurd margins) — count as failures.
3. **Cluster failures by mechanism**, not ticker. A cluster signature is 2–4 bullets with no company names. Clusters of **≥3** rows warrant generic code fixes. Timeouts are **one cluster** regardless of size; fix via [`data/ticker.json`](../../data/ticker.json) overrides or concurrency.
4. If a cluster signature matches a **prior commit** and the symptom still appears in `results.json`, that is a **real signal** — the fix is incomplete or regressed. **Extend it**; don't re-implement from scratch and don't skip it.

### Step 2 — Pick and fix 1–3 clusters

Rank by `rows_affected × confidence_single_commit_fixes_it`. Pick the top 1–3.

For each:

- Widen detection rather than branching on ticker. If you'd write `if (ticker === …)`, move it to `data/ticker.json` instead.
- Add or extend tests in [`tests/`](../../tests/) matching the area (validator, fiscal year, CEO, EBIT).
- Brief comment describing the **pattern**, not companies.
- `npx tsc --noEmit` passes.
- One commit per mechanism: `fix(area): mechanism description (~N rows)`.

### Step 3 — Validate (optional but encouraged)

If you want to confirm a fix helps before recording it, you may run a **targeted subset** of the scraper against affected tickers. Full scrapes are expensive — prefer targeted runs. If you do run the scraper, refresh both `output/results.json` and `output/run_summary.json` from the same execution.

### Step 4 — Record

Append to [`docs/known-issues.md`](../../docs/known-issues.md):

```markdown
## Fix round N
- artifacts: <timestamp from run_summary.json, row count from results.json>
- git_head: <short SHA>
- Fixed: <signature(s)>
- Remaining toward 100%: <count of non-success rows>
```

Commit: `docs: known-issues fix round N`.

### Blocker protocol

If you genuinely cannot ship a code fix this round, commit `blocked: <reason>` and append a `## Blocked` note to `known-issues.md` stating:

- What you tried to diagnose
- What's missing or ambiguous
- The **specific human action** needed to unblock (e.g. *"re-run full scrape"*, *"clarify exemption policy for investment companies"*)

Do **not** auto-escalate blockers into permanent halts. Each round evaluates fresh. If the human pastes the prompt again without the blocker resolved, say so once and stop — do not commit another blocked note.

### Hard rules

- **Ship code when you can.** Docs-only rounds are a failure mode, not a neutral outcome.
- Don't re-implement a fix already in git history unless `results.json` proves the symptom persists — in that case, **extend** the existing fix, don't duplicate it.
- `npx tsc --noEmit` must pass on every commit.
- When in doubt between "halt" and "pick the next-best cluster," **pick the cluster**.

---

## Prompt (copy ends here)

---

## Related

- Operator automation and metrics: [operator-runbook.md](./operator-runbook.md)
- JSON handoff steps: [prompt-templates.md](./prompt-templates.md)
