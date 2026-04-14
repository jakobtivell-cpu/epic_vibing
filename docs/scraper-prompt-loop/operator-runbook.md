# Scraper 100% Prompt Loop Operator Runbook

This runbook implements the prompt loop against this repository's existing scripts and output artifacts.

## Inputs

- Latest dataset: `latest_batch`
- Main results file: `output/results.json`
- Quality summary command: `node scripts/analyze-results-quality.cjs output/results.json`
- Null ledger command: `node scripts/analyze-results-quality.cjs --write-ledger output/results.json`
- Full scraper test command: `node scripts/test-all-companies.cjs`
- Canary gate command: `node scripts/gate-promotion.cjs`

## Runner CLI (recommended)

Use the runner to reduce copy/paste errors across loop steps:

- Initialize handoff:
  - `node scripts/prompt-loop-runner.cjs init`
- Generate next prompt:
  - `node scripts/prompt-loop-runner.cjs prompt --step 1`
- Apply model JSON response to handoff:
  - `node scripts/prompt-loop-runner.cjs apply --step 1 --response output/prompt-loop/step-1-response.json`
- Check progress:
  - `node scripts/prompt-loop-runner.cjs status`

The `apply` command prints the next step command automatically.

Strict guardrails are on by default:

- Enforces step order (cannot skip ahead accidentally)
- Blocks step 7 apply unless `validation.ready_for_test=true`
- On step 7 apply, computes `companies_total`, `companies_100pct`, and `completeness_rate` from `output/results.json`
- On step 8 apply, enforces iteration policy and tracks consecutive full passes automatically

Use `--no-strict` only for emergency/manual recovery.

## Required Metric Definitions

- `companies_total`: number of rows in `output/results.json`
- `companies_100pct`: count of companies meeting 100% completeness definition
- `completeness_rate`: `companies_100pct / companies_total`
- `regression`: any `complete -> partial|failed|timeout` or any headline non-null -> null

## Phase Gates

1. **Diagnosis Gate**
   - Top 3-10 ranked failure classes exist.
   - Each class has measurable impact and expected lift.
2. **Planning Gate**
   - Every task has acceptance criteria and expected contribution.
   - Dependencies and rollback points are explicit.
3. **Risk Gate**
   - Every task has a go/no-go decision.
   - Mitigations and blast radius are documented.
4. **Build Gate**
   - No task marked complete without evidence artifact.
5. **Validation Gate**
   - `ready_for_test=true` required before test run.
6. **Test Gate**
   - Completeness and accuracy metrics computed from latest run.
   - Baseline diff included.

## Iteration Policy

- `completeness_rate < 0.80`: mandatory `full_loop`
- `0.80 <= completeness_rate < 1.00`: mandatory `targeted_loop`
- Stop only if all are true:
  - `completeness_rate == 1.00`
  - no critical validation failures
  - no net-new regression classes
  - 2 consecutive full passes on latest batch

## Context-Window Policy

- Keep handoff payload compact:
  - max 10 failure classes
  - max 20 tasks
  - max 10 active risks
- Keep verbose outputs in artifacts and only reference artifact IDs in handoff.
- When token pressure appears, keep only:
  - `baseline`
  - top failure classes
  - `plan.final_actionable`
  - latest `validation`
  - latest `test_results`

## Suggested Artifact IDs

- `quality_summary_vN` from `analyze-results-quality.cjs`
- `null_ledger_vN` from null ledger output
- `canary_diff_vN` from canary check output
- `full_run_vN` from `test-all-companies.cjs`
- `regression_matrix_vN` from risk review stage

## Execution Sequence

1. Initialize handoff from `handoff-template.json`.
2. Run Step 1 prompt and write updated handoff.
3. Run Step 2 prompt and write updated handoff.
4. Run Step 3 prompt and write updated handoff.
5. Run Step 4 prompt and write updated handoff.
6. Execute Step 5 build tasks, collecting artifact IDs.
7. Execute Step 6 validation checks.
8. Execute Step 7 success-rate test with latest batch.
9. Execute Step 8 loop decision.
10. If `iteration.continue=true`, repeat according to decision.

## Definition of Done

The process is complete only when all conditions hold:

- 100% company completeness on latest batch (`completeness_rate=1.00`)
- field-level accuracy constraints met
- no regression against baseline gates
- two consecutive runs pass under the same criteria
