#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const DEFAULT_HANDOFF = path.resolve(ROOT, 'output', 'prompt-loop', 'handoff.json');
const TEMPLATE_PATH = path.resolve(
  ROOT,
  'docs',
  'scraper-prompt-loop',
  'handoff-template.json',
);
const PROMPTS_MD_PATH = path.resolve(
  ROOT,
  'docs',
  'scraper-prompt-loop',
  'prompt-templates.md',
);
const DEFAULT_RESULTS_PATH = path.resolve(ROOT, 'output', 'results.json');

function usage() {
  console.log(
    [
      'Usage:',
      '  node scripts/prompt-loop-runner.cjs init [--handoff <path>] [--dataset <id>]',
      '  node scripts/prompt-loop-runner.cjs prompt --step <1-8> [--handoff <path>] [--out <path>]',
      '  node scripts/prompt-loop-runner.cjs apply --step <1-8> --response <path> [--handoff <path>]',
      '  node scripts/prompt-loop-runner.cjs status [--handoff <path>]',
      '',
      'Tips:',
      '  - `prompt` emits a copy/paste-ready prompt with current handoff JSON attached.',
      '  - `apply` stores the model JSON response as the new handoff and prints the next step.',
      '  - strict mode is enabled by default; disable with --no-strict.',
    ].join('\n'),
  );
}

function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson(jsonPath) {
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
}

function writeJson(jsonPath, obj) {
  ensureParentDir(jsonPath);
  fs.writeFileSync(jsonPath, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function argValue(name, fallback = undefined) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  if (idx + 1 >= process.argv.length) fail(`Missing value for ${name}`);
  return process.argv[idx + 1];
}

function resolveHandoffPath() {
  const raw = argValue('--handoff', DEFAULT_HANDOFF);
  return path.resolve(ROOT, raw);
}

function strictEnabled() {
  return !process.argv.includes('--no-strict');
}

function nowIso() {
  return new Date().toISOString();
}

function makeRunId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `run-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(
    d.getUTCHours(),
  )}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function loadPromptSections() {
  if (!fs.existsSync(PROMPTS_MD_PATH)) {
    fail(`Prompt templates not found: ${PROMPTS_MD_PATH}`);
  }
  const text = fs.readFileSync(PROMPTS_MD_PATH, 'utf8');

  const globalMatch = text.match(
    /## Global Envelope \(prepend to every step\)\s+```text\s*([\s\S]*?)```/m,
  );
  if (!globalMatch) fail('Could not parse Global Envelope from prompt-templates.md');
  const globalEnvelope = globalMatch[1].trim();

  const stepRegex = /## Step (\d) - [^\n]+\s+```text\s*([\s\S]*?)```/g;
  const steps = {};
  let m;
  while ((m = stepRegex.exec(text)) !== null) {
    steps[Number(m[1])] = m[2].trim();
  }
  for (let i = 1; i <= 8; i += 1) {
    if (!steps[i]) fail(`Could not parse Step ${i} prompt from prompt-templates.md`);
  }

  return { globalEnvelope, steps };
}

function validateTopLevelShape(candidate, template) {
  const missing = [];
  for (const k of Object.keys(template)) {
    if (!(k in candidate)) missing.push(k);
  }
  if (missing.length) {
    fail(`Response JSON missing required top-level keys: ${missing.join(', ')}`);
  }
}

function normalizeRunnerState(handoff) {
  if (!handoff.runner_state || typeof handoff.runner_state !== 'object') {
    handoff.runner_state = {};
  }
  if (!Number.isInteger(handoff.runner_state.expected_step)) {
    handoff.runner_state.expected_step = 1;
  }
  if (!Number.isInteger(handoff.runner_state.last_applied_step)) {
    handoff.runner_state.last_applied_step = 0;
  }
  if (!Number.isInteger(handoff.runner_state.consecutive_full_passes)) {
    handoff.runner_state.consecutive_full_passes = 0;
  }
}

function hasCriticalFailureEntries(list) {
  if (!Array.isArray(list)) return false;
  return list.some((entry) => {
    if (typeof entry === 'string') return /\bcritical\b/i.test(entry);
    if (entry && typeof entry === 'object') {
      const sev = String(entry.severity || '').toLowerCase();
      if (sev === 'critical') return true;
      const text = JSON.stringify(entry);
      return /\bcritical\b/i.test(text);
    }
    return false;
  });
}

function hasNetNewRegression(handoff) {
  if (handoff?.risk_review?.net_new_regression === true) return true;
  if (handoff?.diagnosis?.net_new_regression === true) return true;
  const signals = handoff?.diagnosis?.regression_signals;
  if (!Array.isArray(signals)) return false;
  return signals.some((s) => {
    if (typeof s === 'string') return /\bnet[-_\s]?new\b/i.test(s);
    return s && typeof s === 'object' && s.net_new === true;
  });
}

function loadResultsRows() {
  if (!fs.existsSync(DEFAULT_RESULTS_PATH)) {
    fail(`Results file not found for step 7 enforcement: ${DEFAULT_RESULTS_PATH}`);
  }
  const parsed = readJson(DEFAULT_RESULTS_PATH);
  const rows = Array.isArray(parsed) ? parsed : parsed?.results;
  if (!Array.isArray(rows)) {
    fail(`Unsupported results format in ${DEFAULT_RESULTS_PATH}`);
  }
  return rows;
}

function computeMetricsFromResults() {
  const rows = loadResultsRows();
  const counts = { complete: 0, partial: 0, failed: 0, timeout: 0 };
  for (const row of rows) {
    const k = row && typeof row.status === 'string' ? row.status : 'unknown';
    if (Object.prototype.hasOwnProperty.call(counts, k)) counts[k] += 1;
  }
  const total = rows.length;
  const full = counts.complete;
  const rate = total > 0 ? full / total : 0;
  return { total, full, rate, status_counts: counts };
}

function enforceStep7Metrics(handoff) {
  const m = computeMetricsFromResults();
  handoff.test_results = handoff.test_results || {};
  handoff.baseline = handoff.baseline || {};
  handoff.test_results.companies_total = m.total;
  handoff.test_results.companies_100pct = m.full;
  handoff.test_results.completeness_rate = m.rate;
  handoff.test_results.formula_used = 'companies_100pct / companies_total';
  handoff.baseline.status_counts = m.status_counts;
}

function enforceStep8Decision(handoff) {
  normalizeRunnerState(handoff);
  const rate = Number(handoff?.test_results?.completeness_rate || 0);
  const hasCriticalValidation = hasCriticalFailureEntries(handoff?.validation?.failures);
  const hasCriticalBaseline = hasCriticalFailureEntries(handoff?.baseline?.critical_failures);
  const hasCritical = hasCriticalValidation || hasCriticalBaseline;
  const regression = hasNetNewRegression(handoff);

  const iteration = handoff.iteration && typeof handoff.iteration === 'object' ? handoff.iteration : {};
  iteration.count = Number.isInteger(iteration.count) ? iteration.count + 1 : 1;

  if (rate === 1 && !hasCritical && !regression) {
    handoff.runner_state.consecutive_full_passes += 1;
  } else {
    handoff.runner_state.consecutive_full_passes = 0;
  }

  const stop =
    rate === 1 &&
    !hasCritical &&
    !regression &&
    handoff.runner_state.consecutive_full_passes >= 2;

  if (stop) {
    iteration.decision = 'stop';
    iteration.continue = false;
    iteration.reason = 'stop_criteria_satisfied';
    iteration.next_focus = [];
  } else if (rate < 0.8) {
    iteration.decision = 'full_loop';
    iteration.continue = true;
    iteration.reason = 'completeness_below_80_percent';
  } else if (rate < 1) {
    iteration.decision = 'targeted_loop';
    iteration.continue = true;
    iteration.reason = 'completeness_between_80_and_100_percent';
  } else {
    iteration.decision = 'full_loop';
    iteration.continue = true;
    iteration.reason = `need_stability_or_risk_clearance (consecutive_full_passes=${handoff.runner_state.consecutive_full_passes}, critical=${hasCritical}, net_new_regression=${regression})`;
  }

  handoff.iteration = iteration;
}

function applyStrictGuards(handoff, appliedStep) {
  normalizeRunnerState(handoff);
  if (appliedStep === 7) {
    enforceStep7Metrics(handoff);
  }
  if (appliedStep === 8) {
    enforceStep8Decision(handoff);
  }
  const nextStep = appliedStep < 8 ? appliedStep + 1 : handoff.iteration?.continue ? 1 : null;
  handoff.runner_state.last_applied_step = appliedStep;
  handoff.runner_state.expected_step = nextStep ?? 0;
}

function recommendedNextStep(step, handoff) {
  normalizeRunnerState(handoff);
  if (Number.isInteger(handoff.runner_state.expected_step) && handoff.runner_state.expected_step >= 0) {
    return handoff.runner_state.expected_step === 0 ? null : handoff.runner_state.expected_step;
  }
  if (step < 8) return step + 1;
  const cont = Boolean(handoff?.iteration?.continue);
  return cont ? 1 : null;
}

function commandInit() {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    fail(`Template file not found: ${TEMPLATE_PATH}`);
  }
  const handoffPath = resolveHandoffPath();
  const datasetId = argValue('--dataset', 'latest_batch');
  const tpl = readJson(TEMPLATE_PATH);
  tpl.run_id = makeRunId();
  tpl.dataset_id = datasetId;
  tpl.timestamp_utc = nowIso();
  tpl.iteration = tpl.iteration || {};
  tpl.iteration.count = 0;
  tpl.iteration.decision = 'full_loop';
  tpl.iteration.continue = true;
  tpl.iteration.reason = 'initialized';
  tpl.history = Array.isArray(tpl.history) ? tpl.history : [];
  tpl.runner_state = {
    expected_step: 1,
    last_applied_step: 0,
    consecutive_full_passes: 0,
  };
  tpl.history.push({
    at: nowIso(),
    event: 'initialized_handoff',
    dataset_id: datasetId,
  });

  writeJson(handoffPath, tpl);
  console.log(`Initialized handoff: ${handoffPath}`);
}

function commandPrompt() {
  const stepRaw = argValue('--step');
  if (!stepRaw) fail('Missing --step <1-8>');
  const step = Number(stepRaw);
  if (!Number.isInteger(step) || step < 1 || step > 8) {
    fail(`Invalid step: ${stepRaw}`);
  }

  const handoffPath = resolveHandoffPath();
  if (!fs.existsSync(handoffPath)) {
    fail(`Handoff file not found: ${handoffPath}. Run init first.`);
  }
  const handoff = readJson(handoffPath);
  normalizeRunnerState(handoff);
  if (strictEnabled() && handoff.runner_state.expected_step !== step) {
    fail(
      `Strict mode: expected step ${handoff.runner_state.expected_step}, got step ${step}. Use --no-strict to bypass.`,
    );
  }
  const { globalEnvelope, steps } = loadPromptSections();
  const stepPrompt = steps[step];

  const finalPrompt = [
    globalEnvelope,
    '',
    stepPrompt,
    '',
    'Current handoff JSON:',
    '```json',
    JSON.stringify(handoff, null, 2),
    '```',
    '',
    'Return JSON only.',
  ].join('\n');

  const outPath = argValue(
    '--out',
    path.resolve(ROOT, 'output', 'prompt-loop', `step-${step}-prompt.txt`),
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, finalPrompt, 'utf8');
  console.log(`Wrote prompt: ${outPath}`);
}

function commandApply() {
  const stepRaw = argValue('--step');
  const responsePathRaw = argValue('--response');
  if (!stepRaw) fail('Missing --step <1-8>');
  if (!responsePathRaw) fail('Missing --response <path-to-model-json>');

  const step = Number(stepRaw);
  if (!Number.isInteger(step) || step < 1 || step > 8) {
    fail(`Invalid step: ${stepRaw}`);
  }

  const handoffPath = resolveHandoffPath();
  if (!fs.existsSync(handoffPath)) {
    fail(`Handoff file not found: ${handoffPath}. Run init first.`);
  }
  if (!fs.existsSync(TEMPLATE_PATH)) {
    fail(`Template file not found: ${TEMPLATE_PATH}`);
  }
  const responsePath = path.resolve(ROOT, responsePathRaw);
  if (!fs.existsSync(responsePath)) {
    fail(`Response file not found: ${responsePath}`);
  }

  const template = readJson(TEMPLATE_PATH);
  const currentHandoff = readJson(handoffPath);
  normalizeRunnerState(currentHandoff);
  if (strictEnabled() && currentHandoff.runner_state.expected_step !== step) {
    fail(
      `Strict mode: expected step ${currentHandoff.runner_state.expected_step}, got step ${step}. Use --no-strict to bypass.`,
    );
  }
  const incoming = readJson(responsePath);
  validateTopLevelShape(incoming, template);
  incoming.runner_state = {
    expected_step: currentHandoff.runner_state.expected_step,
    last_applied_step: currentHandoff.runner_state.last_applied_step,
    consecutive_full_passes: currentHandoff.runner_state.consecutive_full_passes,
  };
  incoming.iteration = incoming.iteration && typeof incoming.iteration === 'object' ? incoming.iteration : {};
  if (Number.isInteger(currentHandoff?.iteration?.count)) {
    incoming.iteration.count = currentHandoff.iteration.count;
  }
  normalizeRunnerState(incoming);

  if (strictEnabled() && step === 7 && incoming?.validation?.ready_for_test !== true) {
    fail('Strict mode: Step 7 apply blocked because validation.ready_for_test is not true.');
  }

  incoming.history = Array.isArray(incoming.history) ? incoming.history : [];
  incoming.history.push({
    at: nowIso(),
    event: 'applied_step_response',
    step,
    source: responsePath,
  });
  incoming.timestamp_utc = nowIso();

  if (strictEnabled()) {
    applyStrictGuards(incoming, step);
  } else {
    const nextStep = step < 8 ? step + 1 : incoming?.iteration?.continue ? 1 : null;
    incoming.runner_state.last_applied_step = step;
    incoming.runner_state.expected_step = nextStep ?? 0;
  }

  writeJson(handoffPath, incoming);
  console.log(`Updated handoff: ${handoffPath}`);

  const nextStep = recommendedNextStep(step, incoming);
  if (nextStep === null) {
    console.log('Loop decision indicates stop condition met. No next step required.');
    return;
  }
  console.log(`Next step: ${nextStep}`);
  console.log(
    `Run: node scripts/prompt-loop-runner.cjs prompt --step ${nextStep} --handoff "${handoffPath}"`,
  );
}

function commandStatus() {
  const handoffPath = resolveHandoffPath();
  if (!fs.existsSync(handoffPath)) {
    fail(`Handoff file not found: ${handoffPath}. Run init first.`);
  }
  const handoff = readJson(handoffPath);
  normalizeRunnerState(handoff);
  const total = Number(handoff?.test_results?.companies_total || 0);
  const full = Number(handoff?.test_results?.companies_100pct || 0);
  const rate = total > 0 ? full / total : Number(handoff?.test_results?.completeness_rate || 0);
  const iteration = handoff?.iteration || {};

  console.log(`handoff: ${handoffPath}`);
  console.log(`run_id: ${handoff.run_id || 'n/a'}`);
  console.log(`dataset_id: ${handoff.dataset_id || 'n/a'}`);
  console.log(`iteration_count: ${iteration.count ?? 0}`);
  console.log(`iteration_decision: ${iteration.decision || 'n/a'}`);
  console.log(`iteration_continue: ${iteration.continue === true ? 'true' : 'false'}`);
  console.log(`expected_step: ${handoff.runner_state.expected_step}`);
  console.log(`consecutive_full_passes: ${handoff.runner_state.consecutive_full_passes}`);
  console.log(`completeness_rate: ${Number(rate).toFixed(4)}`);
}

function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }

  if (cmd === 'init') return commandInit();
  if (cmd === 'prompt') return commandPrompt();
  if (cmd === 'apply') return commandApply();
  if (cmd === 'status') return commandStatus();

  fail(`Unknown command: ${cmd}`);
}

main();
