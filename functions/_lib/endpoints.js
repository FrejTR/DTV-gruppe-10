// Logikken bag /api/status og /api/salgstempo, adskilt fra routing, så den kan testes.
import { enAdGangen, gem, laes } from './cache.js';
import { HOVEDLAGER, lavKlient, lavSkriveKlient, RackbeatFejl } from './rackbeat.js';
import { beregnAlle, isoDato, normaliser, tilKlient, vindue } from './salgstempo.js';
import { dataSvar, fejlSvar, iDagIDanmark, json, log } from './svar.js';

export const STATUS_TTL_MS = 20 * 1000;
export const SALGSTEMPO_TTL_MS = 3600 * 1000;
const STATUS_MAX_SIDER = 10;
const SALGSTEMPO_UGER = 52;
const HISTORIK_FOER_VINDUE_UGER = 26;   // Kun til at afgøre, om et produkt er nyt (kort_historik)
// Sikring mod en løbsk hentning: stop med fejl i stedet for at regne på en halv historik.
// 200 sider er ca. 20.000 ordrelinjer. Grænsen kan ændres med SALGSTEMPO_MAX_SIDER.
const maxSiderSalgstempo = env => Math.min(1000, Math.max(1, parseInt(env.SALGSTEMPO_MAX_SIDER, 10) || 200));

/** Fejl i opsætningen skal ikke dækkes af gamle data: dem skal man se med det samme. */
const vigtigt = kode => kode === 'ikke_sat_op';

const klient = (env, deps) => lavKlient({ noegle: env.RACKBEAT_API_KEY, ...deps });

/** Lager pr. varenummer. Mangler nøglen adgang til produkter (403), sendes det som lagerStatus i stedet for en fejl. */
async function hentStatus(env, deps) {
  try {
    return { lager: await klient(env, deps).lager(STATUS_MAX_SIDER), lagerStatus: 'ok' };
  } catch (e) {
    if (!(e instanceof RackbeatFejl) || e.kode !== 'mangler_adgang') throw e;
    log('status', 'lager_' + e.kode, e.status);
    return { lager: null, lagerStatus: 'mangler_adgang' };
  }
}

async function hentSalgstempo(env, deps) {
  const ordrer = klient(env, deps);
  const iDag = iDagIDanmark(deps.nu ? new Date(deps.nu()) : new Date());
  const { start, slut } = vindue(iDag, SALGSTEMPO_UGER);
  const raa = await ordrer.ordrelinjer(isoDato(start - 7 * HISTORIK_FOER_VINDUE_UGER), isoDato(slut), maxSiderSalgstempo(env));
  return tilKlient(beregnAlle(normaliser(raa).linjer, iDag, SALGSTEMPO_UGER), iDag);
}

function fejlkode(e) {
  return e instanceof RackbeatFejl ? e.kode : 'intern_fejl';
}

/** GET /api/status (lager): frisk i 20 sekunder. Ved fejl sendes sidst gemte version som forældet. */
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

// ---------- POST /api/lagerregulering ----------
const SKU = /^[A-Za-z0-9ÆØÅæøå._:-]{1,40}$/;
const REFERENCE = /^[a-z0-9-]{8,64}$/;
const MAX_ANTAL = 10000;   // Sikring mod tastefejl. En batch er typisk 40 til 65 stk.

/** Læser og tjekker kroppen. Returnerer null ved alt, der ikke er præcis det forventede. */
function laesRegulering(k) {
  if (!k || typeof k !== 'object' || Array.isArray(k)) return null;
  const { sku, antal, batch, reference } = k;
  if (typeof sku !== 'string' || !SKU.test(sku)) return null;
  if (!Number.isInteger(antal) || antal < 1 || antal > MAX_ANTAL) return null;
  if (!Number.isInteger(batch) || batch < 1 || batch > 1e6) return null;
  if (typeof reference !== 'string' || !REFERENCE.test(reference)) return null;
  return { sku, antal, batch, reference };
}

/** Kun kald fra kalenderen selv. Vercel Authentication sender login-cookien med, så et kald fra
 *  en anden side skal afvises her (CSRF). Origin skal matche, og kroppen skal være JSON. */
function fraKalenderen(request) {
  const origin = request.headers.get('origin');
  const type = request.headers.get('content-type') || '';
  return origin === new URL(request.url).origin && type.split(';')[0].trim() === 'application/json';
}

/** POST /api/lagerregulering: lægger en godkendt batch på Hovedlager i Rackbeat.
 *  Bruger samme nøgle som læsningen (RACKBEAT_API_KEY). */
export async function lagerregulering({ request, env }, deps = {}) {
  if (!fraKalenderen(request)) return json({ fejl: 'Ugyldigt kald', kode: 'ugyldigt_kald' }, 403);
  let krop = null;
  try { krop = await request.json(); } catch { /* håndteres herunder */ }
  const r = laesRegulering(krop);
  if (!r) return json({ fejl: 'Ugyldige data', kode: 'ugyldige_data' }, 400);
  try {
    const klient = lavSkriveKlient({ noegle: env.RACKBEAT_API_KEY, ...deps });
    const beskrivelse = `Produktionskalender, ref. ${r.reference}`;
    // Er batchen allerede registreret (fx netværksfejl efter et vellykket kald), sendes den ikke igen
    const fundet = await klient.findRegulering(r.reference);
    const dato = iDagIDanmark(deps.nu ? new Date(deps.nu()) : new Date());
    const { id } = fundet || await klient.lagerregulering({ sku: r.sku, antal: r.antal, dato, aarsag: `Batch #${r.batch} godkendt`, beskrivelse });
    log('lagerregulering', fundet ? 'allerede_registreret' : 'oprettet');
    return json({ data: { id, sku: r.sku, antal: r.antal, lokation: HOVEDLAGER, dato, allerede: !!fundet }, kilde: 'rackbeat' }, fundet ? 200 : 201);
  } catch (e) {
    const kode = fejlkode(e);
    log('lagerregulering', kode, e && e.status);
    return fejlSvar(kode);
  }
}
