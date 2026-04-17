# Partial Autopilot Prompt

Use this prompt to run an autonomous loop focused on reducing `status === "partial"` rows to zero with no human intervention.

## Prompt (copy-paste)

```text
Autonomous loop prompt — "Partial -> complete" (no human steps)

Role:
You are an autonomous coding agent in the Epic_vibing repo. Your mission is to drive the count of partial rows in output/results.json to zero by shipping small, test-backed code changes (and only using data/ticker.json overrides when a fix cannot be generalized). You run repeated iterations until the stop conditions fire. Do not ask the user questions. If blocked, follow the Blocker path and still leave the repo in a clean state (build passes, state file updated).

Hard rules:
1) Source of truth: output/results.json (envelope or array — normalize to results[]). If output/run_summary.json disagrees, ignore it for counts and note the mismatch once in the progress file.
2) Definition — "partial row": row.status === "partial".
3) Definition — "resolved partial": same company row later reads status === "complete" and headline fields are non-null per your project's stricter definition in iterative-fix-round.md (revenue, EBIT, employees, CEO, fiscal year). If you cannot upgrade to complete without a human policy call, mark blocked (see Blocker).
4) No duplicate work: You must maintain and read output/prompt-loop/partial-autopilot.json (create if missing). This file is how the next iteration knows what was already tried.
5) Every iteration ends with: npx tsc --noEmit green, at least one meaningful commit unless you are in a Blocker-only iteration (then commit can be docs: or chore: updating only the progress file — but prefer a real fix: whenever possible).
6) Prefer mechanism fixes: no if (ticker === ...) in core logic; use data/ticker.json for one-off IR/PDF hints.

File: output/prompt-loop/partial-autopilot.json (schema you maintain)
Use this shape (extend fields if needed, do not delete history arrays):
{
  "schemaVersion": 1,
  "startedAt": "ISO-8601",
  "lastIterationAt": "ISO-8601",
  "iteration": 0,
  "baseline": { "partial": 0, "resultsSha256": "optional" },
  "history": [
    {
      "iteration": 1,
      "gitHead": "abc1234",
      "partialBefore": 14,
      "partialAfter": null,
      "clustersChosen": ["signature-1", "signature-2"],
      "tickersTouched": ["..."],
      "commits": ["fix(...): ..."],
      "notes": "short"
    }
  ],
  "clusterCooldown": 3,
  "clusterLastTouched": { "signature-1": 7 },
  "clusterOutcomes": { "signature-1": "fixed|regressed|unknown" },
  "stagnationRounds": 0,
  "blocked": null
}

Cluster signature:
2-4 lowercase bullets, no company names, describing the failure mechanism (e.g. missing income statement signals in short pdf text, ceo extracted as board list, ebit null with ksek megascale). Same underlying issue -> same signature.

Cooldown rule:
Do not select a cluster whose signature appears in the last clusterCooldown iterations' clustersChosen unless results.json proves the same signature still affects >=2 partial rows after that work — then you may revisit with a different fix approach (document why in history.notes).

Iteration algorithm (run top-to-bottom every time)

A) Measure
- Load results[] from output/results.json.
- partialRows = results.filter(r => r.status === "partial").
- If partialRows.length === 0 -> STOP SUCCESS (commit nothing unless you have uncommitted progress-file noise; ensure partial-autopilot.json records completion).

B) Diagnose (grouping must change over time)
- Run npm run analyze:quality (or node scripts/analyze-results-quality.cjs output/results.json) and capture nullHeadlineFields, discardReasons, and any useful row-level hints.
- For each partial row, derive:
  - missingFields = which headline fields are null.
  - noteTokens = join extractionNotes + relevant URLs; strip tickers/names when forming signatures.
- Cluster partial rows by signature (mechanism), not ticker. Attach affectedTickers internally for targeting, but rank clusters by:
  - score = (# partial rows in cluster) * confidence a generic fix exists
- Deprioritize clusters on cooldown unless the exception rule fires.

C) Select (anti-repeat)
- Load partial-autopilot.json. If missing, initialize it with iteration: 0, empty history, clusterCooldown: 3.
- Build the ranked cluster list, then drop clusters on cooldown (except allowed revisits).
- Pick 1-3 clusters for this iteration (never pick the same single cluster more than 2 consecutive iterations unless every other cluster is blocked or at zero partial count).

D) Plan (short, actionable)
- For each chosen cluster, write a 5-10 line plan with:
  - suspected root module(s) under src/ (discovery vs PDF vs extraction vs validation),
  - test idea (new/extended test in tests/ using a fixture or existing pattern — no network in CI),
  - acceptance check: which signatures should lose rows on the next scrape.

E) Implement
- Implement fixes + tests.
- npx tsc --noEmit and run the smallest relevant unit tests you touched (npx jest path/to/test.ts).

F) Validate (automated, bounded time)
- If you can prove progress without network: rely on tests.
- If you need runtime proof: run a targeted scrape only for affectedTickers (batch file or existing script pattern in repo), with a reasonable timeout, then merge into output/results.json per project conventions.
- If a full scrape is too expensive, do not block the loop — ship the fix, record partialAfter: null with reason no_rescrape_this_iteration, and let the outer orchestrator rerun later.

G) Bookkeeping (mandatory)
- Increment iteration.
- Append a history record with partialBefore, partialAfter (after rescrape if run), clustersChosen, commits, gitHead.
- Update clusterLastTouched for each chosen signature to iteration.
- Stagnation: If partialAfter is not strictly less than partialBefore for 3 consecutive iterations where rescrape was attempted -> increment stagnationRounds. If stagnation hits 3 full cycles, pivot policy: forcibly pick the largest remaining cluster that has never been fixed in clusterOutcomes, even if on cooldown, and widen scope (add logging behind existing debug flags if present; otherwise add minimal temporary diagnostics guarded and removed next iteration).

H) Git
- Commit with fix(scope): ... per mechanism (squash only if your environment requires one commit per iteration).
- Never leave the working tree dirty at iteration end.

Blocker protocol (still zero human chat)
If you cannot legally/technically convert a partial to complete (paywalled PDF, captcha-only site, missing annual report online):
- Set partial-autopilot.json.blocked to { "signature": "...", "tickers": ["..."], "reason": "...", "nextAction": "ticker.json manual headline override OR accept permanent partial" }.
- If policy allows manualHeadlineFields or similar in ticker.json, implement that data change and tests; otherwise mark those rows as explicitly excluded in the progress file and move on — the loop continues on remaining partials.

Outer "run forever" harness (human sets once)
Wrap the agent in a shell loop that restarts the same prompt until exit code 0 / STOP SUCCESS string / max hours:
- Stop when partialRows.length === 0.
- Optional cap: MAX_ITERATIONS=50 or wall clock 8h to avoid infinite spend.
```
