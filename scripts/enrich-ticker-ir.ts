/**
 * One-off / repeatable enrichment: merge verified IR URLs into data/ticker.json.
 * Run from repo root: npx ts-node scripts/enrich-ticker-ir.ts
 *
 * Does not create new ticker keys — only enriches existing entries.
 * Preserves existing irPage and merges candidateDomains (prepends origin if missing).
 */
import * as fs from 'fs';
import { join } from 'path';

const TICKER_PATH = join(__dirname, '..', 'data', 'ticker.json');

/** Nasdaq Stockholm key → group id (strip .ST and trailing -X share class when X is one letter). */
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

/** Official / canonical IR landing pages (https), keyed by groupKey(symbol). */
const IR_BY_GROUP: Record<string, string> = {
  INVE: 'https://www.investorab.com/en/investors',
  ATCO: 'https://www.atlascopco.com/en/investors',
  VOLV: 'https://www.volvogroup.com/en/investors.html',
  VOLCAR: 'https://www.volvocars.com/investors',
  SAND: 'https://www.home.sandvik/en/investors',
  ASSA: 'https://www.assaabloy.com/group/en/investors',
  ERIC: 'https://www.ericsson.com/en/investors',
  SWED: 'https://www.swedbank.com/investor-relations',
  SEB: 'https://www.sebgroup.com/investor-relations',
  SHB: 'https://www.handelsbanken.com/en/investor-relations',
  EQT: 'https://eqtgroup.com/investors/',
  SAAB: 'https://www.saab.com/investors/',
  HM: 'https://hmgroup.com/investors/',
  EPI: 'https://www.epirocgroup.com/en/investors',
  HEXA: 'https://hexagon.com/en/investors',
  ALFA: 'https://www.alfalaval.com/en/investors/',
  INDU: 'https://www.industrivarden.se/en/investors',
  TELIA: 'https://www.teliacompany.com/en/investors',
  ESSITY: 'https://www.essity.com/en/investors/',
  BOL: 'https://www.boliden.com/en/investors/',
  SKF: 'https://www.skf.com/group/investors',
  TREL: 'https://www.trelleborg.com/en/investors',
  INDT: 'https://www.indutrade.com/en/investors/',
  LIFCO: 'https://www.lifco.com/en/investors/',
  ADDT: 'https://www.addtech.com/investors',
  BEIJ: 'https://www.beijerref.com/en/investors',
  HPOL: 'https://www.hexpol.com/en/investors/',
  HUSQ: 'https://www.husqvarnagroup.com/en/investors',
  ELUX: 'https://www.electroluxgroup.com/en/investors',
  THULE: 'https://www.thulegroup.com/en/investors',
  NIBE: 'https://www.nibe.com/en/investors',
  ALLEI: 'https://www.alleima.com/investors',
  AQ: 'https://www.aqg.se/en/investors/',
  OEM: 'https://www.oem.se/en/investors/',
  SYSR: 'https://www.systemair.com/en/investors',
  GRNG: 'https://www.granges.com/en/investors',
  NOLA: 'https://www.nolato.com/en/investors/',
  'NDA-SE': 'https://www.nordea.com/en/investor-relations',
  AZA: 'https://investors.avanza.se/en/',
  SAVE: 'https://www.nordnet.se/en/about-nordnet/investor-relations',
  KINV: 'https://www.kinnevik.com/investors/',
  LATO: 'https://www.latour.se/en/investors/',
  LUND: 'https://www.lundbergforetagen.se/en/investors/',
  BURE: 'https://www.bure.se/en/investors',
  RATO: 'https://www.ratos.se/en/investors/',
  BALD: 'https://www.balder.se/en/investor-relations/',
  CAST: 'https://www.castellum.com/en/investors/',
  FABG: 'https://www.fabege.com/en/investors/',
  HUFV: 'https://www.hufvudstaden.com/en/investor-relations',
  WIHL: 'https://www.wihlborgs.se/en/investors/',
  SAGA: 'https://www.sagax.se/en/investors/',
  CATE: 'https://www.catena.se/en/investors/',
  PNDX: 'https://www.pandox.se/en/investors/',
  ATRLJ: 'https://www.atriumljungberg.se/en/investors/',
  NP3: 'https://www.np3fastigheter.se/en/investors/',
  WALL: 'https://www.wallenstam.se/en/investors/',
  AZN: 'https://www.astrazeneca.com/investor-relations.html',
  GETI: 'https://www.getinge.com/en/investors',
  EKTA: 'https://www.elekta.com/investors/',
  SOBI: 'https://www.sobi.com/investors/',
  SECT: 'https://investor.sectra.com/en/',
  VITR: 'https://www.vitrolife.com/investors/',
  BIOA: 'https://www.bioarctic.com/en/investors',
  BONEX: 'https://www.bonesupport.com/investors/',
  ALIF: 'https://www.add.life/en/investors',
  AXFO: 'https://www.axfood.com/en/investors/',
  CLAS: 'https://www.clasohlson.com/en/investor-relations/',
  CLA: 'https://www.cloetta.com/investors/',
  RUSTA: 'https://www.rusta.com/en/investor-relations',
  NEWA: 'https://www.newwavegroup.com/en/investors/',
  BETS: 'https://www.betssonab.com/en/investor-relations',
  EVO: 'https://www.evolution.com/investors/',
  PDX: 'https://www.paradoxinteractive.com/investors/',
  MTG: 'https://www.mtg.com/investors',
  SSAB: 'https://www.ssab.com/en/investors/',
  SCA: 'https://www.sca.com/en/investors/',
  HOLM: 'https://www.holmen.com/en/investors/',
  BILL: 'https://www.billerud.com/investors/',
  STE: 'https://www.storaenso.com/en/investors',
  LUMI: 'https://www.lundinmining.com/investors/',
  SKA: 'https://www.skanska.com/investors',
  NCC: 'https://www.ncc.com/en/investors/',
  PEAB: 'https://www.peab.com/investors',
  JM: 'https://www.jm.se/en/investor-relations/',
  SECU: 'https://www.securitas.com/en/investors/',
  LOOMIS: 'https://www.loomis.com/en/investors/',
  AAK: 'https://www.aak.com/en/investors/',
  SWEC: 'https://www.sweco.com/en/investors/',
  AFRY: 'https://afry.com/en/investors',
};

function enrichValue(key: string, val: unknown): unknown {
  const g = groupKey(key);
  const ir = IR_BY_GROUP[g];
  if (!ir) return val;

  if (typeof val === 'string') {
    return {
      name: val,
      irPage: ir,
      candidateDomains: mergeCandidateDomains(undefined, ir),
    };
  }

  if (typeof val !== 'object' || val === null || !('name' in val)) return val;
  const o = val as Record<string, unknown>;
  const name = o.name;
  if (typeof name !== 'string') return val;

  const next: Record<string, unknown> = { ...o };
  const existingIr = typeof o.irPage === 'string' && o.irPage.trim() ? String(o.irPage).trim() : '';

  if (existingIr) {
    const cand = Array.isArray(o.candidateDomains)
      ? (o.candidateDomains as unknown[]).filter((x): x is string => typeof x === 'string')
      : undefined;
    next.candidateDomains = mergeCandidateDomains(cand, existingIr);
    return next;
  }

  next.irPage = ir;
  const cand = Array.isArray(o.candidateDomains)
    ? (o.candidateDomains as unknown[]).filter((x): x is string => typeof x === 'string')
    : undefined;
  next.candidateDomains = mergeCandidateDomains(cand, ir);
  return next;
}

function main(): void {
  const raw = fs.readFileSync(TICKER_PATH, 'utf-8');
  const data = JSON.parse(raw) as Record<string, unknown>;
  if (typeof data !== 'object' || data === null) {
    throw new Error('ticker.json root must be an object');
  }

  const out: Record<string, unknown> = {};
  const usedGroups = new Set<string>();

  for (const key of Object.keys(data)) {
    const enriched = enrichValue(key, data[key]);
    out[key] = enriched;
    const g = groupKey(key);
    if (IR_BY_GROUP[g]) usedGroups.add(g);
  }

  for (const g of Object.keys(IR_BY_GROUP)) {
    if (!usedGroups.has(g)) {
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
