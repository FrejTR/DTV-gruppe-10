// Logikken bag /api/status og /api/salgstempo, adskilt fra routing, så den kan testes.
import { enAdGangen, gem, laes } from './cache.js';
import { lavKlient, RackbeatFejl } from './rackbeat.js';
import { beregnAlle, dagNr, isoDato, normaliser, tilKlient, vindue } from './salgstempo.js';
import { dataSvar, fejlSvar, iDagIDanmark, log } from './svar.js';

export const STATUS_TTL_MS = 20 * 1000;
export const SALGSTEMPO_TTL_MS = 3600 * 1000;
const SALG_DAGE = 7;
const STATUS_MAX_SIDER = 10;
const SALGSTEMPO_UGER = 52;
const HISTORIK_FOER_VINDUE_UGER = 26;   // Kun til at afgøre, om et produkt er nyt (kort_historik)
// Sikring mod en løbsk hentning: stop med fejl i stedet for at regne på en halv historik.
// 200 sider er ca. 20.000 ordrelinjer. Grænsen kan ændres med SALGSTEMPO_MAX_SIDER.
const maxSiderSalgstempo = env => Math.min(1000, Math.max(1, parseInt(env.SALGSTEMPO_MAX_SIDER, 10) || 200));

/** Fejl i opsætningen skal ikke dækkes af gamle data: dem skal man se med det samme. */
const vigtigt = kode => kode === 'ikke_sat_op';

function klienter(env, deps) {
  const basisUrl = deps.basisUrl;
  const ordrer = lavKlient({ noegle: env.RACKBEAT_API_KEY, ...deps, basisUrl });
  const lager = env.RACKBEAT_LAGER_KEY ? lavKlient({ noegle: env.RACKBEAT_LAGER_KEY, ...deps, basisUrl }) : ordrer;
  return { ordrer, lager };
}

async function hentStatus(env, deps) {
  const { ordrer, lager } = klienter(env, deps);
  const til = iDagIDanmark(deps.nu ? new Date(deps.nu()) : new Date());
  const fra = isoDato(dagNr(til) - (SALG_DAGE - 1));
  const { linjer } = normaliser(await ordrer.ordrelinjer(fra, til, STATUS_MAX_SIDER));
  const salg = {};
  for (const l of linjer) {
    const dag = isoDato(l.dag);
    salg[l.sku] = salg[l.sku] || {};
    salg[l.sku][dag] = (salg[l.sku][dag] || 0) + l.antal;
  }
  // Lagerdelen må gerne mangle (nøglen har måske kun adgang til ordrer). Så sendes resten alligevel.
  let lagerData = null, lagerStatus = 'ok';
  try {
    lagerData = await lager.lager(STATUS_MAX_SIDER);
  } catch (e) {
    if (!(e instanceof RackbeatFejl) || (e.kode !== 'mangler_adgang' && e.kode !== 'noegle_afvist')) throw e;
    lagerStatus = 'mangler_adgang';
    log('status', 'lager_' + e.kode, e.status);
  }
  return { lager: lagerData, lagerStatus, salg, salgFra: fra, salgTil: til };
}

async function hentSalgstempo(env, deps) {
  const { ordrer } = klienter(env, deps);
  const iDag = iDagIDanmark(deps.nu ? new Date(deps.nu()) : new Date());
  const { start, slut } = vindue(iDag, SALGSTEMPO_UGER);
  const raa = await ordrer.ordrelinjer(isoDato(start - 7 * HISTORIK_FOER_VINDUE_UGER), isoDato(slut), maxSiderSalgstempo(env));
  return tilKlient(beregnAlle(normaliser(raa).linjer, iDag, SALGSTEMPO_UGER), iDag);
}

function fejlkode(e) {
  return e instanceof RackbeatFejl ? e.kode : 'intern_fejl';
}

/** GET /api/status: frisk i 20 sekunder. Ved fejl sendes sidst gemte version som forældet. */
export async function status({ request, env, waitUntil }, deps = {}) {
  const nu = deps.nu || Date.now;
  const origin = new URL(request.url).origin;
  const gammel = await laes(origin, 'status');
  if (gammel && nu() - gammel.hentet < STATUS_TTL_MS) return dataSvar(gammel, false);
  try {
    const post = await enAdGangen('status', async () => {
      const ny = { data: await hentStatus(env, deps), hentet: nu() };
      await gem(origin, 'status', ny);
      return ny;
    });
    return dataSvar(post, false);
  } catch (e) {
    const kode = fejlkode(e);
    log('status', kode, e && e.status);
    if (gammel && !vigtigt(kode)) return dataSvar(gammel, true);
    return fejlSvar(kode);
  }
}

/** GET /api/salgstempo: frisk i 1 time. Derefter sendes den gamle version, mens en ny beregnes i baggrunden. */
export async function salgstempo({ request, env, waitUntil }, deps = {}) {
  const nu = deps.nu || Date.now;
  const origin = new URL(request.url).origin;
  const genberegn = () => enAdGangen('salgstempo', async () => {
    const ny = { data: await hentSalgstempo(env, deps), hentet: nu() };
    await gem(origin, 'salgstempo', ny);
    return ny;
  });
  const gammel = await laes(origin, 'salgstempo');
  if (gammel) {
    const alder = nu() - gammel.hentet;
    if (alder >= SALGSTEMPO_TTL_MS) {
      const baggrund = genberegn().catch(e => log('salgstempo', fejlkode(e), e && e.status));
      if (waitUntil) waitUntil(baggrund);
    }
    // Forældet, når en ny beregning ikke er lykkedes i over to timer
    return dataSvar(gammel, alder >= 2 * SALGSTEMPO_TTL_MS);
  }
  try {
    return dataSvar(await genberegn(), false);
  } catch (e) {
    const kode = fejlkode(e);
    log('salgstempo', kode, e && e.status);
    return fejlSvar(kode);
  }
}
