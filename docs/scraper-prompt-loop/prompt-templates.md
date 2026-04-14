# Scraper 100% Prompt Templates

Use these prompts in sequence. Each prompt must consume the latest handoff JSON and return updated handoff JSON only.

## Global Envelope (prepend to every step)

```text
You are operating a scraper quality-improvement loop.
Input is a JSON handoff object.
Output must be valid JSON only, preserving all existing top-level fields.
Never remove existing data; only append/update.
If required information is missing, set `blocking_questions` and propose default assumptions.
Always include a section-level `confidence` score from 0.0 to 1.0.
Limit output to top-impact items and use artifact IDs instead of long logs.
```

## Step 1 - Situation Evaluation

```text
Analyze `dataset_id=latest_batch` from the current handoff.
Produce a failure taxonomy for why companies are not 100% complete.
Quantify impact per class and identify top regressions from prior known-good behavior.
Prioritize issues by expected lift if fixed.

Update `diagnosis` with:
- `failure_classes` (3-10 ranked classes)
- `root_causes`
- `data_quality_signals`
- `regression_signals`
- `priority_order`
- `expected_lift_estimate` (per class/fix)
- `confidence`

Also update `baseline` if missing with objective metrics.
Return JSON only.
```

## Step 2 - Plan Creation

```text
Using only the current handoff (`diagnosis` and `baseline`), create a phased remediation plan maximizing completeness and minimizing regression risk.
Include:
- quick wins
- structural fixes
- fallback hardening
- selector/heuristic hardening
- timeout/retry tuning
- normalization improvements

Update `plan` with:
- `phases`
- `tasks` (each with acceptance criteria and expected contribution)
- `owner_role`
- `dependencies`
- `success_metrics`
- `rollback_points`
- `time_cost_estimates`
- `confidence`

Return JSON only.
```

## Step 3 - Plan Risk and Success Evaluation

```text
Critically evaluate `plan` for expected success and regression risk.
Score each task on:
- `success_probability`
- `blast_radius`
- `regression_risk`
- `observability_coverage`
- `reversibility`

Simulate best/base/worst outcomes and recommend modifications before execution.

Update `risk_review` with:
- `risk_matrix`
- `task_scores`
- `scenario_simulation`
- `go_no_go`
- `mitigations`
- `confidence`

Return JSON only.
```

## Step 4 - Build-Ready Actionable Plan

```text
Convert the risk-reviewed plan into a build-ready spec.
Reorder by ROI-first and safe sequencing.
Add checkpoints, test hooks, feature flags/guardrails, and stop conditions.

Update `plan.final_actionable` with:
- `ordered_tasks`
- `pre_checks`
- `implementation_steps`
- `post_checks`
- `abort_conditions`
- `rollback_steps`
- `definition_of_done`:
  - completeness_target=1.0
  - min_consecutive_full_passes=2
  - accuracy_constraints
  - regression_constraints

Return JSON only.
```

## Step 5 - Build Execution

```text
Execute `plan.final_actionable`.
For each completed task, provide evidence artifact IDs and short proof.
Do not mark complete without evidence.

Update `execution` with:
- `completed_tasks`
- `deviations`
- `blocked_items`
- `artifacts`
- `change_summary`
- `confidence`

Append a short event entry to `history`.
Return JSON only.
```

## Step 6 - Validation

```text
Validate implementation against `definition_of_done`.
Run static and behavioral checks for:
- selector correctness
- parsing accuracy
- deduplication integrity
- timeout handling
- retry behavior
- fallback paths

Update `validation` with:
- `checks_run`
- `failures`
- `fixes_applied`
- `residual_risks`
- `ready_for_test` (true/false)
- `confidence`

If `ready_for_test=false`, include exact remediation tasks and do not proceed to Step 7.
Return JSON only.
```

## Step 7 - Success-Rate Test

```text
Run scraper test on `dataset_id=latest_batch`.
Compute:
- `companies_total`
- `companies_100pct`
- `completeness_rate` using exact formula `companies_100pct / companies_total`
- field-level accuracy checks
- error distributions
- diff vs baseline

Update `test_results` with those metrics and `confidence`.
Append test artifact IDs in `execution.artifacts` if needed.
Return JSON only.
```

## Step 8 - Iteration Controller

```text
Make the loop decision from current `test_results`, `validation`, and `risk_review`.

Rules:
- If `completeness_rate < 0.80` -> `decision=full_loop`, `continue=true`
- If `0.80 <= completeness_rate < 1.00` -> `decision=targeted_loop`, `continue=true`
- Stop only when all are true:
  - `completeness_rate == 1.00`
  - no critical validation failures
  - no net-new regression class
  - at least 2 consecutive full passes

Update `iteration`:
- increment `count`
- set `decision`, `continue`, `reason`, `next_focus`

If continuing:
- `full_loop`: restart from Step 1 using all failure classes
- `targeted_loop`: restart from Step 1 but scope to unresolved top-impact classes only

Append loop decision to `history`.
Return JSON only.
```
