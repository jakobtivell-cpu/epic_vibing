# Contributing

Short guide for changes to this scraper.

## Add a new company

1. Edit **`data/ticker.json`** and add the Nasdaq Stockholm symbol as a key.
2. Use an object value with at least **`name`** and a verified **`irPage`** (HTTPS).
3. Add **`candidateDomains`** when you know the corporate site — it speeds discovery but is not strictly required.
4. **Never** overwrite the entire `ticker.json` from a script without a **backup** of the previous file.

See `README.md` for the exact JSON shape used elsewhere in the file.

## Run checks before committing

```bash
npx tsc --noEmit
npx jest
```

**Do not commit** with failing typecheck or tests.

If you touch **`src/utils/http-client.ts`**, run **`npx jest`** before and after your edit (see `.cursorrules`).

## New discovery logic

Any new discovery behavior should include or extend a test under **`tests/`** so regressions are caught without live scrapes.

## Schema changes

If you change the **public** output shape in **`src/types.ts`** (fields written to `results.json`), update **`README.md`** and bump the version in **`package.json`** (and keep `CHANGELOG.md` in sync).

## Commit messages

Use a prefix so history stays scannable:

| Prefix | Use for |
|--------|---------|
| `feat:` | New behavior or modules |
| `fix:` | Bug fixes |
| `verified:` | Confirmed scrape outcome / golden data (when you record verification) |
| `data:` | `ticker.json`, `entity-confusion.json`, or other data assets |

Example: `fix: sanitize PDF redirect URLs with encoded quotes`

## Rate limits during development

- Prefer **`--ticker "SYMBOL"`** for one company instead of the full default ten while iterating.
- Use **`--slow`** when a host starts returning **403** / **429**.
- Add pauses between manual reruns; switching network (e.g. hotspot) can help after a block.
- Avoid removing pipeline fallback stages without documenting the reason in the PR (see `.cursorrules`).
