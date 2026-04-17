import * as fs from "fs";
import * as path from "path";
import { buildCompanyProfilesForEveryTickerEntry, buildCompanyProfilesForTickers } from "./src/data/all-ticker-companies";
import { loadTickerMap, getTickerMap, resolveTicker } from "./src/data/ticker-map";

loadTickerMap();
const allKeys = Object.keys(getTickerMap()).sort((a, b) => a.localeCompare(b));
const full = buildCompanyProfilesForEveryTickerEntry();
const fullSet = new Set(full.map((p) => p.ticker));

const missing = allKeys.filter((k) => !fullSet.has(k.split(".")[0] + "." + k.split(".").slice(1).join(".")));
// full uses normalizeTickerForLookup - simpler: missing from profile tickers
const profileTickers = new Set(full.map((p) => p.ticker!));
const missingKeys = allKeys.filter((k) => {
  const { normalizeTickerForLookup } = require("./src/data/ticker-map");
  return false;
});
