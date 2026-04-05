// ---------------------------------------------------------------------------
// LLM extraction — OpenAI-compatible JSON API; no fabrication guardrails in prompt.
// ---------------------------------------------------------------------------

import axios, { AxiosError } from 'axios';
import { createLogger } from '../utils/logger';
import { verifyQuoteInDocument } from './evidence';
import type { FieldEvidence } from './types';

const log = createLogger('llm-challenger');

export interface LlmRawField {
  value: number | string | null;
  page: number | null;
  source_quote: string | null;
  unit_stated: string | null;
  reporting_scope: string | null;
  normalization: string[] | null;
}

export interface LlmExtractJson {
  revenue_msek: LlmRawField;
  ebit_msek: LlmRawField;
  employees: LlmRawField;
  ceo: LlmRawField;
  fiscal_year: LlmRawField;
}

function emptyField(): LlmRawField {
  return {
    value: null,
    page: null,
    source_quote: null,
    unit_stated: null,
    reporting_scope: null,
    normalization: [],
  };
}

function parseLlmJson(text: string): LlmExtractJson | null {
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    const pick = (k: string): LlmRawField => {
      const v = obj[k];
      if (!v || typeof v !== 'object') return emptyField();
      const o = v as Record<string, unknown>;
      return {
        value:
          typeof o.value === 'number' || typeof o.value === 'string'
            ? o.value
            : o.value === null
              ? null
              : null,
        page: typeof o.page === 'number' && o.page >= 1 ? Math.floor(o.page) : null,
        source_quote: typeof o.source_quote === 'string' ? o.source_quote : null,
        unit_stated: typeof o.unit_stated === 'string' ? o.unit_stated : null,
        reporting_scope: typeof o.reporting_scope === 'string' ? o.reporting_scope : null,
        normalization: Array.isArray(o.normalization)
          ? o.normalization.filter((x): x is string => typeof x === 'string')
          : [],
      };
    };
    return {
      revenue_msek: pick('revenue_msek'),
      ebit_msek: pick('ebit_msek'),
      employees: pick('employees'),
      ceo: pick('ceo'),
      fiscal_year: pick('fiscal_year'),
    };
  } catch {
    return null;
  }
}

function buildPrompt(companyLegalName: string, context: string): string {
  return `You are extracting structured facts from an annual report excerpt. Company: "${companyLegalName}".

Rules:
- Return ONLY valid JSON matching the schema below. No markdown, no prose.
- Use null for any field you cannot support with a verbatim quote that appears in the excerpt.
- Every non-null value MUST include source_quote: a contiguous substring copied from the excerpt (>= 12 characters) that supports the number or CEO name.
- For CEO: quote must come from leadership, CEO statement, signing section, or similar — not marketing or unrelated names.
- For fiscal_year: the quote must explicitly state the financial/annual year (e.g. "financial year 2025", "räkenskapsåret 2025"). Do not infer from filename or headers alone.
- revenue_msek and ebit_msek must be in millions of SEK (MSEK). Convert from SEK, thousands, billions, BSEK, or Mkr as needed and list steps in normalization.
- employees: average or year-end FTE/employees as a plain integer (headcount).
- page: 1-based page number if you can infer it from page markers in the excerpt; otherwise null.

JSON schema (all keys required):
{
  "revenue_msek": { "value": number|null, "page": number|null, "source_quote": string|null, "unit_stated": string|null, "reporting_scope": string|null, "normalization": string[] },
  "ebit_msek": { ... same shape ... },
  "employees": { ... same shape ... },
  "ceo": { "value": string|null, ... },
  "fiscal_year": { "value": number|null, ... }
}

EXCERPT:
${context}`;
}

function rawToEvidence(
  raw: LlmRawField,
  track: 'llm',
  fullText: string,
): { evidence: FieldEvidence | null; quoteOk: boolean } {
  if (raw.value === null || raw.value === undefined) {
    return { evidence: null, quoteOk: false };
  }
  const quote = raw.source_quote?.trim() ?? '';
  const quoteOk = quote.length >= 12 && verifyQuoteInDocument(quote, fullText);
  const norm = [...(raw.normalization ?? [])];
  if (raw.unit_stated) norm.push(`Unit stated: ${raw.unit_stated}`);
  if (raw.reporting_scope) norm.push(`Scope: ${raw.reporting_scope}`);
  norm.push('LLM extraction (challenger track)');
  if (!quoteOk && quote.length >= 12) norm.push('QUOTE_NOT_FOUND_IN_DOCUMENT');

  const snippet = quote.length >= 12 ? quote : null;

  let value: number | string | null = raw.value;
  if (typeof value === 'number' && !Number.isFinite(value)) value = null;
  if (value === null) return { evidence: null, quoteOk: false };

  return {
    evidence: {
      track,
      value,
      page: raw.page,
      sourceTextSnippet: snippet,
      normalizationApplied: norm,
    },
    quoteOk,
  };
}

export interface LlmExtractResult {
  ok: true;
  parsed: LlmExtractJson;
  evidences: {
    revenue_msek: { evidence: FieldEvidence | null; quoteOk: boolean };
    ebit_msek: { evidence: FieldEvidence | null; quoteOk: boolean };
    employees: { evidence: FieldEvidence | null; quoteOk: boolean };
    ceo: { evidence: FieldEvidence | null; quoteOk: boolean };
    fiscalYear: { evidence: FieldEvidence | null; quoteOk: boolean };
  };
}

export interface LlmExtractError {
  ok: false;
  error: string;
}

export async function runLlmExtraction(
  companyLegalName: string,
  fullText: string,
  context: string,
): Promise<LlmExtractResult | LlmExtractError> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    return { ok: false, error: 'OPENAI_API_KEY not set' };
  }

  const base =
    process.env.OPENAI_BASE_URL?.trim()?.replace(/\/$/, '') ?? 'https://api.openai.com/v1';
  const model = process.env.LLM_MODEL?.trim() || 'gpt-4o-mini';
  const prompt = buildPrompt(companyLegalName, context);

  try {
    const resp = await axios.post(
      `${base}/chat/completions`,
      {
        model,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        timeout: 120_000,
      },
    );

    const content = resp.data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      return { ok: false, error: 'Empty LLM response' };
    }

    const parsed = parseLlmJson(content);
    if (!parsed) {
      return { ok: false, error: 'LLM returned non-JSON or invalid shape' };
    }

    const mapField = (raw: LlmRawField) => rawToEvidence(raw, 'llm', fullText);

    return {
      ok: true,
      parsed,
      evidences: {
        revenue_msek: mapField(parsed.revenue_msek),
        ebit_msek: mapField(parsed.ebit_msek),
        employees: mapField(parsed.employees),
        ceo: mapField(parsed.ceo),
        fiscalYear: mapField(parsed.fiscal_year),
      },
    };
  } catch (e) {
    const ax = e as AxiosError;
    const msg = ax.response?.data
      ? JSON.stringify(ax.response.data).slice(0, 500)
      : ax.message;
    log.warn(`LLM extraction failed: ${msg}`);
    return { ok: false, error: msg };
  }
}
