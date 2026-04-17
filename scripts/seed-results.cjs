const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'output', 'results.json');
const DST = path.join(ROOT, 'app', 'data', 'seed-results.json');

if (!fs.existsSync(SRC)) {
  console.error(`Source results file not found: ${SRC}`);
  process.exit(1);
}

const raw = fs.readFileSync(SRC, 'utf8');
// Validate JSON shape before copying so we do not commit a broken seed.
JSON.parse(raw);

fs.mkdirSync(path.dirname(DST), { recursive: true });
fs.writeFileSync(DST, raw, 'utf8');
console.log(`Seeded dashboard results: ${SRC} -> ${DST}`);
