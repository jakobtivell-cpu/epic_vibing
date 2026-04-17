# Partial Autopilot Prompt

Use this prompt to run an autonomous loop focused on reducing `status === "partial"` rows to zero with no human intervention.

## Prompt (copy-paste)

```text
Autonomous Loop Prompt — "Partial -> Complete" v2

For: Cursor background agent (or any autonomous coding agent)
Repo: epic_vibing
Goal: Drive partial rows in output/results.json to zero via iterative code fixes.
Key change from v1: This prompt is designed to be run repeatedly. Each run MUST resume from prior state — never start fresh.

---

## STEP 0 — RESUME (mandatory, always first)

Before doing anything else, load your state file:

cat output/prompt-loop/partial-autopilot.json

- If the file exists: you are resuming. Read iteration, history, clusterLastTouched, clusterOutcomes, and blocked. You MUST print a resume summary (see below) before proceeding to Step 1.
- If the file does not exist: you are on iteration 1. Create it with the schema below, then proceed.

### Mandatory resume summary (print this verbatim pattern):

=== AUTOPILOT RESUME — iteration <N+1> ===
Prior iterations: <N>
Last clusters tried: <list from history[-1].clustersChosen>
Last outcome: <partialBefore> -> <partialAfter> (or "no rescrape")
Clusters on cooldown: <list with iteration last touched>
Blocked tickers: <list or "none">
Stagnation rounds: <count>
===

If you skip this summary, you are violating the protocol. This is the mechanism that prevents re-doing the same work.

---

## STEP 1 — MEASURE

node scripts/analyze-results-quality.cjs output/results.json

Also load results directly:

// pseudocode — use however your environment reads JSON
const raw = JSON.parse(fs.readFileSync('output/results.json'));
const results = Array.isArray(raw) ? raw : raw.results || raw.data || [];
const partials = results.filter(r => r.status === 'partial');

- If partials.length === 0 -> STOP SUCCESS. Update state file with completion record. Exit.
- Otherwise: record partialBefore = partials.length and continue.

---

## STEP 2 — DIAGNOSE & CLUSTER

For each partial row, extract:
- missingFields: which of [revenue_msek, ebit_msek, employees, ceo, fiscal_year] are null
- mechanism: why it's null — from extractionNotes, PDF URLs, discard reasons

Cluster by mechanism (not by ticker). A cluster signature is 2-4 lowercase phrases describing the failure, e.g.:
- ebit-discarded-exceeds-revenue
- pdf-not-found-no-ir-page
- ceo-extracted-as-board-list
- timeout-no-data-extracted

Same root cause = same signature, even across different companies.

Rank clusters by: (number of partial rows) * (confidence a generic code fix exists)

---

## STEP 3 — SELECT (anti-repeat rules)

Load cooldown info from state file. Apply these rules strictly:

1. Cooldown: Do NOT pick a cluster that appears in clustersChosen of the last 3 iterations — UNLESS results.json still shows >=2 partial rows with that same signature AND you have a different fix approach (document why in notes).
2. Consecutive limit: Never pick the same single cluster more than 2 iterations in a row.
3. Pick 1-3 clusters per iteration. Prefer breadth over depth.
4. If all clusters are on cooldown or blocked: pick the largest never-fixed cluster (override cooldown). Document this as a "forced pivot" in notes.

---

## STEP 4 — PLAN (keep short)

For each chosen cluster, write a plan (5-10 lines max):
- Suspected root module(s): src/discovery/, src/pdf/, src/extraction/, src/validation/
- Test idea: what test to add/extend in tests/ (no network calls in tests)
- Acceptance: which signatures should lose rows after fix

---

## STEP 5 — IMPLEMENT & TEST

1. Implement fixes. Prefer mechanism fixes — no if (ticker === 'XYZ') in core logic. Use data/ticker.json only for one-off PDF/IR hints.
2. Run npx tsc --noEmit — must pass.
3. Run relevant unit tests: npx jest path/to/changed-test.ts

---

## STEP 6 — VALIDATE

Choose one:
- Tests-only (preferred if fix is testable without network): rely on passing tests.
- Targeted rescrape (if runtime proof needed): run only affected tickers with timeout. Merge results back into output/results.json.
- Skip rescrape (if too expensive): record partialAfter: null with reason: "no_rescrape_this_iteration". The next iteration or outer harness will rerun later.

---

## STEP 7 — BOOKKEEPING (mandatory, never skip)

Update output/prompt-loop/partial-autopilot.json:

{
  "iteration": N+1,
  "lastIterationAt": "ISO-8601-now",
  "history": [
    // ...existing entries...,
    {
      "iteration": N+1,
      "gitHead": "<current HEAD hash>",
      "partialBefore": <count before>,
      "partialAfter": <count after rescrape, or null>,
      "clustersChosen": ["sig-1", "sig-2"],
      "tickersTouched": ["TICK-A", "TICK-B"],
      "commits": ["fix(extraction): ..."],
      "notes": "short description of what was done and why"
    }
  ],
  "clusterLastTouched": {
    // update touched clusters to current iteration number
  },
  "clusterOutcomes": {
    // "sig-1": "fixed" | "regressed" | "unknown"
  }
}

Stagnation check: If partialAfter >= partialBefore for 3 consecutive rescrape iterations -> increment stagnationRounds. At stagnation 3: force-pick the largest never-fixed cluster, even if on cooldown.

---

## STEP 8 — GIT

- Commit with fix(scope): <mechanism description>
- Never leave the working tree dirty.
- If this was a blocker-only iteration, use chore: or docs: prefix.

---

## Blocker Protocol

If a partial cannot be converted to complete (paywalled PDF, captcha, no annual report online):

1. Set blocked in state file: { "signature": "...", "tickers": [...], "reason": "...", "nextAction": "ticker.json override OR accept permanent partial" }
2. If data/ticker.json supports manual headline overrides -> implement that data change.
3. Otherwise: mark as excluded and move on. The loop continues on remaining partials.

---

## State File Schema

{
  "schemaVersion": 1,
  "startedAt": "ISO-8601",
  "lastIterationAt": "ISO-8601",
  "iteration": 0,
  "baseline": { "partial": 14, "resultsSha256": "optional" },
  "history": [],
  "clusterCooldown": 3,
  "clusterLastTouched": {},
  "clusterOutcomes": {},
  "stagnationRounds": 0,
  "blocked": null
}

---

## Hard Rules Summary

| Rule | Detail |
|------|--------|
| Source of truth | output/results.json (envelope-aware) |
| Partial = | row.status === "partial" |
| Complete = | status complete + all 5 headline fields non-null |
| No ticker-specific core logic | Use data/ticker.json for one-offs |
| State file | output/prompt-loop/partial-autopilot.json — read AND write every iteration |
| TypeScript | npx tsc --noEmit must pass before commit |
| Git | Clean tree at iteration end, conventional commits |

---

## Stop Conditions

- partials.length === 0 -> STOP SUCCESS
- iteration >= 50 -> stop (configurable cap)
- Wall clock > 8h -> stop
- All remaining partials are in blocked -> STOP BLOCKED

---

## What Changed from v1

1. Step 0 (Resume) is now mandatory and first — v1 buried state-loading in step C, causing agents to skip prior work.
2. Mandatory resume summary printout — forces the agent to acknowledge what was already tried before planning new work.
3. 40% shorter — removed prose repetition, used tables and code blocks for scannability.
4. Anti-repeat rules are explicit numbered rules — not embedded in paragraph prose.
5. "You are resuming" framing — the default assumption is continuation, not a fresh start.
```
