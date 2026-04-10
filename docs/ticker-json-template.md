# `data/ticker.json` — rich entry template

Use an **object** value per ticker (not a bare string) when you need IR seeds, optional overrides, or structured fallbacks. All URLs should be **HTTPS** where the site supports it; relative URLs are normalized on load.

## Minimal rich entry

```json
{
  "EXAMPLE-B.ST": {
    "name": "Example AB (publ)",
    "irPage": "https://www.example.com/en/investors/reports",
    "candidateDomains": ["https://www.example.com"]
  }
}
```

## Full optional shape (precision-first fallbacks)

Copy and adjust; remove keys you do not need.

```json
{
  "EXAMPLE-B.ST": {
    "name": "Example AB (publ)",
    "orgNumber": "556000-0000",
    "companyType": "industrial",
    "irPage": "https://www.example.com/en/investors/reports",
    "candidateDomains": [
      "https://www.example.com",
      "https://ir.example.com"
    ],
    "isin": "SE0000000000",
    "irEmail": "ir@example.com",

    "annualReportPdfUrls": [
      "https://www.example.com/globalassets/annual-report-2025.pdf",
      "https://www.example.com/globalassets/annual-report-2024.pdf"
    ],
    "overrideFiscalYear": 2025,

    "cmsApiUrls": [
      "https://cdn.example.com/api/v1/reports-index.json"
    ],

    "aggregatorUrls": [
      "https://storage.mfn.se/.../example-annual-report-2025.pdf",
      "https://www.nasdaq.com/.../issuer-news-page"
    ]
  }
}
```

### Field reference

| Field | Purpose |
|-------|---------|
| `name` | Legal / display name (required for object entries). |
| `irPage` | Preferred IR landing URL; first Cheerio scan target. |
| `candidateDomains` | Extra origins to try in multi-domain cycling. |
| `annualReportPdfUrls` | **Tier 0** — curated annual-report PDFs, tried **before** discovery. Same quality gates as any other PDF. Order = preference (newest first). |
| `overrideFiscalYear` | Optional hint embedded in candidate metadata (does not bypass validation). |
| `cmsApiUrls` | **Tier 4** — HTTP(S) endpoints whose JSON or HTML is scanned for `.pdf` links after primary IR paths fail. |
| `aggregatorUrls` | **Tier 8** — direct PDFs or listing pages on **allowlisted** hosts only (`mfn.se`, `storage.mfn.se`, `nasdaq.com`, `cision.com`, `news.cision.com`). Unknown hosts are ignored with a warning. |

### Operational notes

- Refresh **`annualReportPdfUrls`** when the issuer publishes a new year; stale URLs produce download failures and the pipeline continues down the ladder.
- **`cmsApiUrls`** should return JSON or HTML that actually contains annual-report PDF URLs; arbitrary APIs are not guaranteed to work without inspection.
- For **Playwright** control in broken Linux runtimes (e.g. missing `libglib`), set environment variables (see [README](../README.md#environment) or architecture doc).
