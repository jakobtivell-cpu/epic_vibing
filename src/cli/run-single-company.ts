// ---------------------------------------------------------------------------
// Child process entry: one company, one pipeline run. Writes JSON to a file.
// Invoked by src/cli/child-runner.ts via fork + ts-node or compiled dist/*.js.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import { runPipeline, type RunPipelineOptions } from '../pipeline';
import { loadTickerMap } from '../data/ticker-map';
import type { CompanyProfile } from '../types';

interface ChildInput {
  company: CompanyProfile;
  force: boolean;
  options?: RunPipelineOptions;
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath || !outputPath) {
    process.stderr.write('run-single-company: need <input.json> <output.json>\n');
    process.exit(1);
  }
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf-8')) as ChildInput;
  loadTickerMap();
  const results = await runPipeline([input.company], input.force, {
    ...input.options,
    sequential: false,
  });
  fs.writeFileSync(outputPath, JSON.stringify(results[0]), 'utf-8');
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`run-single-company: ${msg}\n`);
  process.exit(1);
});
