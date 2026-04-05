/**
 * Merge curated IR URLs (and optional ISIN / IR email) into data/ticker.json.
 * Run from repo root: npx ts-node scripts/enrich-ticker-ir.ts
 *
 * Sources: verified issuer IR pages. Does not create new ticker keys.
 * When a group matches, irPage is refreshed from the curated list; isin / irEmail
 * are set when provided and left unchanged otherwise. candidateDomains are merged
 * with the IR URL origin.
 *
 * Extra groups not in the public CSV (still in ticker.json): OEM, NP3, ALIF.
 */
import * as fs from 'fs';
import { join } from 'path';

const TICKER_PATH = join(__dirname, '..', 'data', 'ticker.json');

interface GroupSeed {
  irPage: string;
  isin?: string;
  irEmail?: string;
}

/** Nasdaq Stockholm key → group id (strip .ST and trailing -X when X is one letter). */
function groupKey(symbolKey: string): string {
  const s = symbolKey.toUpperCase().replace(/\.ST$/i, '');
  const parts = s.split('-');
  const last = parts[parts.length - 1];
  if (parts.length >= 2 && last.length === 1 && /^[A-Z]$/.test(last)) {
    return parts.slice(0, -1).join('-');
  }
  return s;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

function mergeCandidateDomains(
  existing: string[] | undefined,
  irPage: string,
): string[] {
  const domains = [...(existing ?? [])].filter((x) => typeof x === 'string');
  let origin: string;
  try {
    origin = new URL(irPage).origin;
  } catch {
    return domains;
  }
  const nh = hostOf(origin);
  if (!nh) return domains;
  const seen = new Set(
    domains
      .map((d) => {
        try {
          return new URL(/^https?:\/\//i.test(d) ? d : `https://${d}`)
            .hostname.replace(/^www\./, '')
            .toLowerCase();
        } catch {
          return '';
        }
      })
      .filter(Boolean),
  );
  if (!seen.has(nh)) domains.unshift(origin);
  return domains;
}

/** Curated seeds keyed by groupKey (OMX symbol stem). */
const SEED_BY_GROUP: Record<string, GroupSeed> = {
  INVE: {
    irPage: 'https://www.investorab.com/investors',
    isin: 'SE0000107419',
    irEmail: 'ir@investorab.com',
  },
  ATCO: {
    irPage: 'https://www.atlascopcogroup.com/en/investor-relations',
    isin: 'SE0017486897',
    irEmail: 'ir@atlascopco.com',
  },
  VOLV: {
    irPage: 'https://www.volvogroup.com/en/investors.html',
    isin: 'SE0000115446',
    irEmail: 'ir@volvo.com',
  },
  VOLCAR: {
    irPage: 'https://investors.volvocars.com',
    isin: 'SE0016844831',
    irEmail: 'investors@volvocars.com',
  },
  SAND: {
    irPage: 'https://www.home.sandvik/en/investors/',
    isin: 'SE0000667891',
    irEmail: 'investor.relations@sandvik.com',
  },
  ASSA: {
    irPage: 'https://www.assaabloy.com/group/en/investors',
    isin: 'SE0007100581',
    irEmail: 'ir@assaabloy.com',
  },
  ERIC: {
    irPage: 'https://www.ericsson.com/en/investors',
    isin: 'SE0000108656',
    irEmail: 'investor.relations@ericsson.com',
  },
  SWED: {
    irPage: 'https://www.swedbank.com/investor-relations',
    isin: 'SE0000242455',
    irEmail: 'ir@swedbank.com',
  },
  SEB: {
    irPage: 'https://sebgroup.com/investor-relations',
    isin: 'SE0000148884',
    irEmail: 'ir@seb.se',
  },
  SHB: {
    irPage: 'https://www.handelsbanken.com/en/investor-relations',
    isin: 'SE0007100599',
    irEmail: 'ir@handelsbanken.se',
  },
  EQT: {
    irPage: 'https://eqtgroup.com/investors',
    isin: 'SE0012853455',
    irEmail: 'ir@eqtpartners.com',
  },
  SAAB: {
    irPage: 'https://www.saab.com/investors',
    isin: 'SE0021921269',
    irEmail: 'investor.relations@saabgroup.com',
  },
  HM: {
    irPage: 'https://hmgroup.com/investors/',
    isin: 'SE0000106270',
    irEmail: 'hmir@hm.com',
  },
  EPI: {
    irPage: 'https://www.epirocgroup.com/en/investors',
    isin: 'SE0011166933',
    irEmail: 'ir@epiroc.com',
  },
  HEXA: {
    irPage: 'https://investors.hexagon.com',
    isin: 'SE0015961909',
    irEmail: 'ir@hexagon.com',
  },
  ALFA: {
    irPage: 'https://www.alfalaval.com/investors/',
    isin: 'SE0000695876',
    irEmail: 'ir@alfalaval.com',
  },
  INDU: {
    irPage: 'https://www.industrivarden.net/investors',
    isin: 'SE0000190126',
    irEmail: 'info@industrivarden.se',
  },
  TELIA: {
    irPage: 'https://www.teliacompany.com/en/investors',
    isin: 'SE0000667925',
    irEmail: 'ir@teliacompany.com',
  },
  ESSITY: {
    irPage: 'https://www.essity.com/investors/',
    isin: 'SE0009922164',
    irEmail: 'investor.relations@essity.com',
  },
  BOL: {
    irPage: 'https://www.boliden.com/investors',
    isin: 'SE0020050417',
    irEmail: 'ir@boliden.com',
  },
  SKF: {
    irPage: 'https://investors.skf.com',
    isin: 'SE0000108227',
    irEmail: 'investor.relations@skf.com',
  },
  TREL: { irPage: 'https://www.trelleborg.com/en/investors' },
  INDT: { irPage: 'https://www.indutrade.com/investors' },
  LIFCO: { irPage: 'https://lifco.se/investors/' },
  ADDT: { irPage: 'https://www.addtech.com/investors/' },
  BEIJ: { irPage: 'https://www.beijerref.com/investors/' },
  HPOL: { irPage: 'https://www.hexpol.com/en/investors' },
  HUSQ: { irPage: 'https://www.husqvarnagroup.com/en/investors' },
  DOM: { irPage: 'https://www.dometicgroup.com/en/investors' },
  ELUX: {
    irPage: 'https://www.electroluxgroup.com/en/investor-relations/',
    isin: 'SE0016589188',
    irEmail: 'ir@electrolux.com',
  },
  THULE: { irPage: 'https://www.thulegroup.com/en/investors' },
  NIBE: {
    irPage: 'https://www.nibe.com/investors',
    isin: 'SE0015988019',
    irEmail: 'ir@nibe.se',
  },
  ALLEI: { irPage: 'https://www.alleima.com/en/investors/' },
  AQ: { irPage: 'https://www.aqgroup.com/investors/' },
  SYSR: { irPage: 'https://www.systemair.com/en/investors/' },
  GRNG: { irPage: 'https://www.granges.com/investors/' },
  NOLA: { irPage: 'https://www.nolato.com/en/investors/' },
  'NDA-SE': {
    irPage: 'https://www.nordea.com/en/investors',
    isin: 'FI4000297767',
    irEmail: 'ir@nordea.com',
  },
  AZA: { irPage: 'https://investors.avanza.se' },
  SAVE: { irPage: 'https://www.nordnetab.com/investors/' },
  KINV: { irPage: 'https://www.kinnevik.com/investors/' },
  LATO: { irPage: 'https://www.latour.se/investors/' },
  LUND: { irPage: 'https://www.lundbergforetagen.se/en/investors' },
  BURE: { irPage: 'https://www.bure.se/en/investors/' },
  RATO: { irPage: 'https://www.ratos.com/investors/' },
  BALD: { irPage: 'https://www.balder.se/en/investors/' },
  CAST: { irPage: 'https://www.castellum.com/investors/' },
  FABG: { irPage: 'https://www.fabege.se/en/investors/' },
  HUFV: { irPage: 'https://www.hufvudstaden.se/en/investor-relations/' },
  WIHL: { irPage: 'https://www.wihlborgs.se/en/investor-relations/' },
  SAGA: { irPage: 'https://www.sagax.se/en/investors/' },
  CATE: { irPage: 'https://www.catenafastigheter.se/en/investors/' },
  PNDX: { irPage: 'https://www.pandox.se/en/investors/' },
  ATRLJ: { irPage: 'https://www.al.se/en/investors/' },
  CORE: { irPage: 'https://www.corem.se/en/investors/' },
  WALL: { irPage: 'https://wallenstam.se/en/investor-relations/' },
  AZN: { irPage: 'https://www.astrazeneca.com/investor-relations.html' },
  GETI: { irPage: 'https://www.getinge.com/int/investors/' },
  EKTA: { irPage: 'https://www.elekta.com/investors/' },
  SOBI: { irPage: 'https://www.sobi.com/en/investors' },
  SECT: { irPage: 'https://investor.sectra.com' },
  VITR: { irPage: 'https://www.vitrolife.com/en/investors' },
  BIOA: { irPage: 'https://www.bioarctic.com/en/investors/' },
  BONEX: { irPage: 'https://www.bonesupport.com/en/investors/' },
  AXFO: { irPage: 'https://www.axfood.com/investor/' },
  CLAS: { irPage: 'https://about.clasohlson.com/en/investors/' },
  CLA: { irPage: 'https://www.cloetta.com/en/investors/' },
  RUSTA: { irPage: 'https://investors.rusta.com' },
  NEWA: { irPage: 'https://www.nwg.se/en/investors/' },
  BETS: { irPage: 'https://www.betssonab.com/investors/' },
  EVO: { irPage: 'https://www.evolution.com/investors/' },
  EMBRAC: { irPage: 'https://embracer.com/investors/' },
  PDX: { irPage: 'https://www.paradoxinteractive.com/en/investors' },
  MTG: { irPage: 'https://www.mtg.com/investors/' },
  TIGO: { irPage: 'https://www.millicom.com/investors/' },
  SSAB: { irPage: 'https://www.ssab.com/en/investors' },
  SCA: { irPage: 'https://www.sca.com/en/investors/' },
  HOLM: { irPage: 'https://www.holmen.com/en/investors/' },
  BILL: { irPage: 'https://www.billerud.com/investors' },
  STE: { irPage: 'https://www.storaenso.com/en/investors' },
  LUMI: { irPage: 'https://lundinmining.com/investors/' },
  SKA: { irPage: 'https://group.skanska.com/investors/' },
  NCC: { irPage: 'https://www.ncc.com/investor/' },
  PEAB: { irPage: 'https://www.peab.com/investor-relations/' },
  JM: { irPage: 'https://www.jm.se/en/investors/' },
  SECU: {
    irPage: 'https://www.securitas.com/en/investors/',
    isin: 'SE0000163594',
    irEmail: 'ir@securitas.com',
  },
  LOOMIS: { irPage: 'https://www.loomis.com/en/investors' },
  AAK: { irPage: 'https://www.aak.com/investors/' },
  INTRUM: { irPage: 'https://www.intrum.com/investors/' },
  SWEC: { irPage: 'https://www.swecogroup.com/investor-relations/' },
  AFRY: { irPage: 'https://afry.com/en/investor-relations' },
  /** Listed in ticker.json but not in the shared CSV row set */
  OEM: { irPage: 'https://www.oem.se/en/investors/' },
  NP3: { irPage: 'https://www.np3fastigheter.se/en/investors/' },
  ALIF: { irPage: 'https://www.add.life/en/investors' },
};

function enrichValue(key: string, val: unknown): unknown {
  const g = groupKey(key);
  const seed = SEED_BY_GROUP[g];
  if (!seed) return val;

  if (typeof val === 'string') {
    return {
      name: val,
      irPage: seed.irPage,
      ...(seed.isin ? { isin: seed.isin } : {}),
      ...(seed.irEmail ? { irEmail: seed.irEmail } : {}),
      candidateDomains: mergeCandidateDomains(undefined, seed.irPage),
    };
  }

  if (typeof val !== 'object' || val === null || !('name' in val)) return val;
  const o = val as Record<string, unknown>;
  if (typeof o.name !== 'string') return val;

  const next: Record<string, unknown> = { ...o };
  next.irPage = seed.irPage;
  if (seed.isin) next.isin = seed.isin;
  if (seed.irEmail) next.irEmail = seed.irEmail;

  const cand = Array.isArray(o.candidateDomains)
    ? (o.candidateDomains as unknown[]).filter((x): x is string => typeof x === 'string')
    : undefined;
  next.candidateDomains = mergeCandidateDomains(cand, seed.irPage);
  return next;
}

/** Curated CSV rows whose group never appears in ticker.json (no new keys added). */
const CSV_EXPECTED_MISSING = [
  'TIGO',
  'CORE',
  'INTRUM',
  'DOM',
  'EMBRAC',
  'RATO',
  'JM',
] as const;

function main(): void {
  const raw = fs.readFileSync(TICKER_PATH, 'utf-8');
  const data = JSON.parse(raw) as Record<string, unknown>;
  if (typeof data !== 'object' || data === null) {
    throw new Error('ticker.json root must be an object');
  }

  const keys = Object.keys(data);
  for (const shortTicker of CSV_EXPECTED_MISSING) {
    const hasAny = keys.some((k) => groupKey(k) === shortTicker);
    if (!hasAny) {
      console.warn(
        `[enrich-ticker-ir] Curated list includes "${shortTicker}" but no listing key maps to that group in ticker.json — not enriched.`,
      );
    }
  }

  const out: Record<string, unknown> = {};
  const usedGroups = new Set<string>();

  for (const key of keys) {
    const enriched = enrichValue(key, data[key]);
    out[key] = enriched;
    const g = groupKey(key);
    if (SEED_BY_GROUP[g]) usedGroups.add(g);
  }

  const missingOk = new Set<string>([...CSV_EXPECTED_MISSING]);
  for (const g of Object.keys(SEED_BY_GROUP)) {
    if (!usedGroups.has(g) && !missingOk.has(g)) {
      console.warn(
        `[enrich-ticker-ir] No ticker key maps to group "${g}" — company likely missing from ticker.json (not added).`,
      );
    }
  }

  const text = `${JSON.stringify(out, null, 4)}\n`;
  fs.writeFileSync(TICKER_PATH, text, 'utf-8');

  JSON.parse(fs.readFileSync(TICKER_PATH, 'utf-8'));
  console.log(`[enrich-ticker-ir] Wrote ${TICKER_PATH} (${Object.keys(out).length} keys). JSON.parse OK.`);
}

main();
