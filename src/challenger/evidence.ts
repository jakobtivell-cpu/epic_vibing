// ---------------------------------------------------------------------------
// Evidence helpers — page estimation, context windows, quote verification.
// ---------------------------------------------------------------------------

import type { FieldProvenance } from '../extraction/field-extractor';

const MAX_SNIPPET_LEN = 400;

/** Collapse whitespace for robust substring checks. */
export function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Estimate 1-based page from where a snippet first appears in the full PDF text.
 * Uses uniform density (no per-page map) — approximate but stable.
 */
export function estimatePageFromSnippet(
  fullText: string,
  snippet: string | null | undefined,
  pageCount: number,
): number | null {
  if (!fullText || pageCount < 1) return null;
  const needle = (snippet ?? '').trim();
  if (needle.length < 8) return null;
  const idx = fullText.indexOf(needle.slice(0, Math.min(120, needle.length)));
  if (idx < 0) {
    const c = collapseWs(needle).slice(0, 80);
    if (c.length < 8) return null;
    const hay = collapseWs(fullText);
    const j = hay.indexOf(c);
    if (j < 0) return null;
    const ratio = j / Math.max(1, hay.length);
    return Math.min(pageCount, Math.max(1, Math.floor(ratio * pageCount) + 1));
  }
  const ratio = idx / Math.max(1, fullText.length);
  return Math.min(pageCount, Math.max(1, Math.floor(ratio * pageCount) + 1));
}

export function verifyQuoteInDocument(quote: string | null | undefined, fullText: string): boolean {
  if (!quote || quote.length < 12) return false;
  const q = quote.trim();
  if (fullText.includes(q)) return true;
  const qc = collapseWs(q);
  if (qc.length < 12) return false;
  return collapseWs(fullText).includes(qc);
}

export function deterministicNormalizationNotes(
  field: 'revenue_msek' | 'ebit_msek' | 'employees' | 'ceo' | 'fiscalYear',
  prov: FieldProvenance | null,
): string[] {
  const out: string[] = ['Deterministic rule-based extractor'];
  if (prov?.context) out.push(`context=${prov.context}`);
  if (prov?.matchedLabel) out.push(`label="${prov.matchedLabel}"`);
  if (field === 'revenue_msek' || field === 'ebit_msek') {
    out.push('Stored as MSEK after pipeline unit detection');
  }
  if (field === 'fiscalYear') {
    out.push('Fiscal year from explicit year patterns in report text (not filename)');
  }
  return out;
}

/**
 * Build excerpts for the LLM: front matter + windows around income-statement anchors.
 * Capped to limit tokens; deterministic path is unchanged.
 */
export function buildLlmContextWindows(fullText: string, maxChars: number = 72_000): string {
  if (!fullText) return '';
  const head = fullText.slice(0, 18_000);
  const anchors = [
    /resultaträkning/gi,
    /income\s+statement/gi,
    /statement\s+of\s+(?:profit|income|loss)/gi,
    /koncernens\s+resultaträkning/gi,
    /chief\s+executive|verkställande\s+direktör|\bCEO\b|president\s+and\s+ceo/gi,
  ];
  const chunks: string[] = [`[SECTION:HEAD]\n${head}`];
  let used = head.length;

  for (const re of anchors) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let hits = 0;
    while ((m = re.exec(fullText)) !== null && hits < 2) {
      const start = Math.max(0, m.index - 1_200);
      const end = Math.min(fullText.length, m.index + 4_500);
      const block = fullText.slice(start, end);
      const tag = `[SECTION:ANCHOR offset=${m.index} pattern=${re.source.slice(0, 40)}]\n`;
      const piece = tag + block;
      if (used + piece.length > maxChars) break;
      chunks.push(piece);
      used += piece.length;
      hits++;
    }
  }

  return chunks.join('\n\n---\n\n');
}

export function clipSnippet(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  if (!t) return null;
  return t.length > MAX_SNIPPET_LEN ? `${t.slice(0, MAX_SNIPPET_LEN)}…` : t;
}
