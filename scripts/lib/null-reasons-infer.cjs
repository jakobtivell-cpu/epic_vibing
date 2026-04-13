'use strict';

/**
 * Structured null reasons for headline fields — used by analyze:quality --write-ledger
 * and regression tooling. Values are stable string IDs for dashboards.
 */

function joinNotes(row) {
  const notes = row.extractionNotes || [];
  return notes.join(' | ');
}

function inferEbitNullReason(row) {
  const d = row.extractedData;
  if (d && d.ebit_msek !== null) return null;

  if (row.status === 'timeout') return 'timeout';
  if (row.status === 'failed' && !d) return 'no_extracted_data';

  const s = joinNotes(row);
  if (/Pipeline timed out/i.test(s)) return 'timeout';
  if (/EBIT not extracted|EBIT not found/i.test(s)) return 'not_found';
  if (/discarding ebit for assignment safety|semantic mismatch/i.test(s)) return 'validator_bank_semantic_mismatch';
  if (/exceeds revenue|EBIT \(.*\) exceeds revenue/i.test(s)) return 'validator_ebit_gt_revenue';
  if (/EBIT implausibly large/i.test(s)) return 'validator_ebit_implausible';
  if (/fused-year artifact.*ebit/i.test(s)) return 'extractor_fused_year_artifact';

  return d ? 'unknown_null_after_validation' : 'no_extracted_data';
}

function inferEmployeesNullReason(row) {
  const d = row.extractedData;
  if (d && d.employees !== null) return null;

  if (row.status === 'timeout') return 'timeout';
  if (row.status === 'failed' && !d) return 'no_extracted_data';

  const s = joinNotes(row);
  if (/Pipeline timed out/i.test(s)) return 'timeout';
  if (/Employee count not extracted|Employees not found/i.test(s)) return 'not_found';
  if (/fiscal-year column misread/i.test(s)) return 'extractor_year_column_misread';
  if (/implausibly high/i.test(s) && /employee/i.test(s)) return 'validator_employee_implausible_high';
  if (/too low .*industrial large-cap/i.test(s)) return 'validator_industrial_floor';
  if (/Employee count too low/i.test(s)) return 'validator_employee_too_low';
  if (/portfolio\/holdings headcount/i.test(s)) return 'policy_investment_company_headcount';
  if (/SUSPECT_LOW:.*employees/i.test(s)) return 'extractor_suspect_low_vs_revenue';

  return d ? 'unknown_null_after_validation' : 'no_extracted_data';
}

function inferRevenueNullReason(row) {
  const d = row.extractedData;
  if (d && d.revenue_msek !== null) return null;
  if (row.status === 'timeout') return 'timeout';
  if (!d) return 'no_extracted_data';
  const s = joinNotes(row);
  if (/Revenue not extracted|Revenue not found/i.test(s)) return 'not_found';
  if (/Investment company — standard revenue not applicable/i.test(s)) return 'policy_investment_company';
  if (/implausibly high|below 1,000|non-positive/i.test(s) && /revenue/i.test(s)) return 'validator_revenue_discard';
  return 'unknown_null_after_validation';
}

function inferCeoNullReason(row) {
  const d = row.extractedData;
  if (d && d.ceo !== null) return null;
  if (row.status === 'timeout') return 'timeout';
  if (!d) return 'no_extracted_data';
  const s = joinNotes(row);
  if (/CEO not found|CEO not extracted/i.test(s)) return 'not_found';
  if (/non-person ESEF/i.test(s)) return 'extractor_non_person_ceo';
  return 'unknown_null_after_validation';
}

function inferRow(row) {
  return {
    company: row.company,
    ticker: row.ticker ?? null,
    status: row.status,
    ebit_msek: inferEbitNullReason(row),
    employees: inferEmployeesNullReason(row),
    revenue_msek: inferRevenueNullReason(row),
    ceo: inferCeoNullReason(row),
  };
}

function tally(rows, field) {
  const m = {};
  for (const r of rows) {
    const reason = r[field];
    if (reason == null) continue;
    m[reason] = (m[reason] || 0) + 1;
  }
  return m;
}

function buildLedger(rows) {
  const perRow = rows.map(inferRow);
  return {
    generatedAt: new Date().toISOString(),
    sourceRowCount: rows.length,
    perRow,
    tallies: {
      ebit_msek: tally(perRow, 'ebit_msek'),
      employees: tally(perRow, 'employees'),
      revenue_msek: tally(perRow, 'revenue_msek'),
      ceo: tally(perRow, 'ceo'),
    },
  };
}

module.exports = {
  inferEbitNullReason,
  inferEmployeesNullReason,
  inferRevenueNullReason,
  inferCeoNullReason,
  inferRow,
  buildLedger,
};
