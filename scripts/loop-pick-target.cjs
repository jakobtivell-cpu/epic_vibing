/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const resultsPath = path.join(root, 'output', 'results.json');
const statePath = path.join(root, 'output', 'prompt-loop', 'state.auto.json');

const j = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
const st = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
const att = new Set(st.attempted_targets || []);

const fields = ['revenue_msek', 'ebit_msek', 'employees', 'ceo'];
const rows = [];
for (const r of j.results || []) {
  const ed = r.extractedData || {};
  const missing = fields.filter((x) => ed[x] == null || ed[x] === '');
  if (!missing.length) continue;
  const present = 4 - missing.length;
  rows.push({ company: r.company, ticker: r.ticker, present, missing });
}
rows.sort((a, b) => b.present - a.present);

const off = new Date().getSeconds() % (rows.length || 1);
let pick = null;
for (let i = 0; i < rows.length; i++) {
  const row = rows[(off + i) % rows.length];
  if (row.present < 2) continue;
  for (const field of row.missing) {
    const k = `${row.company}/${field}`;
    if (!att.has(k)) {
      pick = { ...row, field };
      break;
    }
  }
  if (pick) break;
}

const complete100 = (j.results || []).filter((r) => r.status === 'complete' && r.confidence === 100).length;
const total = (j.results || []).length;

console.log(
  JSON.stringify(
    {
      off,
      nonCompleteCount: rows.length,
      pick,
      companies_100pct: complete100,
      companies_total: total,
      completeness_rate: total ? complete100 / total : 0,
    },
    null,
    2,
  ),
);
