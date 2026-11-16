// Logikken bag /api/data (fælles data i Supabase) og /api/pak (pak fra produktionslageret til Rackbeat).
import { HOVEDLAGER, lavSkriveKlient, RackbeatFejl } from './rackbeat.js';
import { DataFejl, lavDataKlient } from './supabase.js';
import { fejlSvar, fraKalenderen, iDagIDanmark, json, log } from './svar.js';

const MAX_KROP = 1024 * 1024;   // 1 MB. Al kalenderens data fylder langt mindre
const MAX_STK = 1000;           // Poster pr. liste i ét kald
const MAX_POST = 4096;          // Tegn pr. batch, reservation eller produkt som JSON
const MAX_ANTAL = 100000;
const BATCH_STATUS = new Set(['aktiv', 'planlagt', 'kasseret']);
// Produktindstillinger, der deles. Lager, salgstempo og optælling hentes fra Rackbeat i hver kalender.
const PRODUKT_FELTER = ['id', 'name', 'sku', 'type', 'min', 'batch', 'cure', 'steps', 'archived'];
const SKU = /^[A-Za-z0-9ÆØÅæøå._:-]{1,40}$/;
const REF = /^[a-z0-9-]{8,64}$/;

const db = (env, deps) => lavDataKlient({ url: env.SUPABASE_URL, noegle: env.SUPABASE_SECRET_KEY, ...deps.db });

const erObjekt = x => !!x && typeof x === 'object' && !Array.isArray(x);
const erTekst = (x, max = 80) => typeof x === 'string' && x.trim().length > 0 && x.length <= max && !/[\u0000-\u001f]/.test(x);
const erHel = (x, min, max) => Number.isInteger(x) && x >= min && x <= max;
const erDato = x => {
  if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x)) return false;
  const d = new Date(x + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === x;
};
const lille = x => JSON.stringify(x).length <= MAX_POST;

// Databasen regner produktionslageret ud fra pid, qty, rejected, made, cure og status, så de skal være i orden
const godBatch = b => erObjekt(b) && lille(b) && erHel(b.no, 1, Number.MAX_SAFE_INTEGER) && erTekst(b.pid)
  && erHel(b.qty, 0, MAX_ANTAL) && (b.rejected == null || erHel(b.rejected, 0, b.qty)) && erDato(b.made)
  && erHel(b.cure, 0, 365) && BATCH_STATUS.has(b.status);
const godReservation = r => erObjekt(r) && lille(r) && erTekst(r.id) && erTekst(r.pid) && erHel(r.qty, 0, MAX_ANTAL) && erDato(r.date);
const godtProdukt = p => erObjekt(p) && lille(p) && erTekst(p.id) && erTekst(p.name, 200);

/** Tjekker en liste i {gem, slet}. Returnerer null ved fejl. */
function liste(del, god, godNoegle) {
  if (del === undefined) return {};
  if (!erObjekt(del)) return null;
  const { gem = [], slet = [] } = del;
  if (!Array.isArray(gem) || !Array.isArray(slet) || gem.length > MAX_STK || slet.length > MAX_STK) return null;
  if (!gem.every(god) || !slet.every(godNoegle)) return null;
  return { gem, slet };
}

/** Læser ændringer til gem_data. Returnerer null ved alt, der ikke er præcis det forventede. */
function laesAendringer(k) {
  if (!erObjekt(k) || Object.keys(k).some(n => !['batches', 'reservationer', 'produkter', 'personer'].includes(n))) return null;
  const batches = liste(k.batches, godBatch, n => erHel(n, 1, Number.MAX_SAFE_INTEGER));
  const reservationer = liste(k.reservationer, godReservation, id => erTekst(id));
  const produkter = liste(k.produkter, godtProdukt, id => erTekst(id));
  if (!batches || !reservationer || !produkter) return null;
  let personer = {};
  if (k.personer !== undefined) {
    const gem = erObjekt(k.personer) ? k.personer.gem : null;
    if (!Array.isArray(gem) || gem.length > MAX_STK || !gem.every(n => erTekst(n))) return null;
    personer = { gem: gem.map(n => n.trim()) };
  }
  if (produkter.gem) produkter.gem = produkter.gem.map(p => Object.fromEntries(PRODUKT_FELTER.filter(f => p[f] !== undefined).map(f => [f, p[f]])));
  return { batches, reservationer, produkter, personer };
}

async function laesKrop(request) {
  const tekst = await request.text();
  if (tekst.length > MAX_KROP) return undefined;
  try { return JSON.parse(tekst); } catch { return undefined; }
}

function fejlkode(e) {
  return e instanceof DataFejl || e instanceof RackbeatFejl ? e.kode : 'intern_fejl';
}

const dataSvar = data => json({ data, hentet: new Date().toISOString(), forældet: false, kilde: 'supabase' });

/** GET /api/data: alle fælles data (personer, produkter, batches, reservationer og pakninger). */
export async function hentData({ env }, deps = {}) {
  try {
    return dataSvar(await db(env, deps).rpc('hent_data', {}));
  } catch (e) {
    const kode = fejlkode(e);
    log('data', kode, e && e.status);
    return fejlSvar(kode, 'supabase');
  }
}

/** POST /api/data: gemmer ændringer fra en kalender og sender alle data tilbage. */
export async function gemData({ request, env }, deps = {}) {
  if (!fraKalenderen(request)) return json({ fejl: 'Ugyldigt kald', kode: 'ugyldigt_kald' }, 403);
  const aendringer = laesAendringer(await laesKrop(request));
  if (!aendringer) return json({ fejl: 'Ugyldige data', kode: 'ugyldige_data' }, 400);
  try {
    const klient = db(env, deps);
    await klient.rpc('gem_data', aendringer);
    return dataSvar(await klient.rpc('hent_data', {}));
  } catch (e) {
    const kode = fejlkode(e);
    log('data', kode, e && e.status);
    return fejlSvar(kode, 'supabase');
  }
}

function laesPakning(k) {
  if (!erObjekt(k)) return null;
  const { ref, pid, sku, antal, kasseret = 0 } = k;
  if (typeof ref !== 'string' || !REF.test(ref) || !erTekst(pid) || typeof sku !== 'string' || !SKU.test(sku)) return null;
  if (!erHel(antal, 1, 10000) || !erHel(kasseret, 0, antal)) return null;
  return { ref, pid, sku, antal, kasseret };
}

const labels = pakning => pakning.linjer.map(l => '#' + (l.label || l.batch)).join(', ');

/** POST /api/pak: tager antal stk. ud af produktionslageret (ældste batch, der er klar, først) og lægger de
 *  godkendte (antal - kasseret) på Hovedlager i Rackbeat.
 *  1. Databasen reserverer stk. fra batchene (låst, så to kalendere ikke kan tage de samme).
 *  2. Rackbeat: lagerregulering oprettes og bogføres.  3. Databasen markerer pakningen som bogført.
 *  Samme ref kan sendes igen efter en fejl: der tages ikke stk. ud to gange, og Rackbeat får kun én regulering. */
export async function pak({ request, env }, deps = {}) {
  if (!fraKalenderen(request)) return json({ fejl: 'Ugyldigt kald', kode: 'ugyldigt_kald' }, 403);
  const k = laesPakning(await laesKrop(request));
  if (!k) return json({ fejl: 'Ugyldige data', kode: 'ugyldige_data' }, 400);
  const dato = iDagIDanmark(deps.nu ? new Date(deps.nu()) : new Date());

  let data, pakning;
  try {
    data = db(env, deps);
    // Uden Rackbeat-nøgle reserveres intet
    if (!env.RACKBEAT_API_KEY) return fejlSvar('ikke_sat_op');
    pakning = await data.rpc('reserver_pakning', { ...k, idag: dato });
  } catch (e) {
    const kode = fejlkode(e);
    if (kode === 'ikke_nok_klar') {
      const klar = Number(e.detalje) || 0;
      return json({ fejl: `Der er kun ${klar} stk. klar til pakning`, kode, klar }, 409);
    }
    log('pak', kode, e && e.status);
    return fejlSvar(kode, 'supabase');
  }
  if (pakning.status === 'bogfoert') {
    return json({ data: { pakning, rackbeat: null, allerede: true }, kilde: 'supabase' }, 200);
  }

  const godkendt = pakning.antal - pakning.kasseret;
  let rb = null, regulering = null, skrevet = false;
  try {
    if (godkendt > 0) {
      rb = lavSkriveKlient({ noegle: env.RACKBEAT_API_KEY, ...deps.rackbeat });
      // Findes reguleringen allerede (et tidligere forsøg nåede til Rackbeat), oprettes den ikke igen
      const fundet = await rb.findRegulering(pakning.ref);
      skrevet = true;
      const { id } = fundet || await rb.lagerregulering({ sku: pakning.sku, antal: godkendt, dato,
        aarsag: `Pakket fra batch ${labels(pakning)}`, beskrivelse: `Produktionskalender, ref. ${pakning.ref}` });
      if (!fundet || !fundet.bogfoert) await rb.bogfoer(id);
      regulering = { id, antal: godkendt, lokation: HOVEDLAGER, dato };
    }
  } catch (e) {
    const kode = fejlkode(e);
    log('pak', 'rackbeat_' + kode, e && e.status);
    // Ville Rackbeat sætte lageret, er kladden slettet og intet bogført: stk. gives tilbage til produktionslageret
    const udfald = await efterFejl(data, skrevet && kode !== 'ville_saette_lager' ? rb : null, pakning.ref);
    if (!erObjekt(udfald)) return json({ ...(await fejlSvar(kode).json()), pakning: udfald }, 502);
    // Reguleringen blev bogført alligevel (fx svaret gik tabt)
    pakning = udfald.pakning;
    regulering = { id: udfald.id, antal: godkendt, lokation: HOVEDLAGER, dato };
  }

  if (pakning.status !== 'bogfoert') {
    try {
      pakning = await data.rpc('bekraeft_pakning', { ref: pakning.ref, rackbeatId: regulering ? regulering.id : null });
    } catch (e) {
      // Rackbeat er opdateret. Pakningen står som reserveret, til samme ref sendes igen, så stk. er stadig taget ud.
      const kode = fejlkode(e);
      log('pak', 'bekraeft_' + kode, e && e.status);
      return json({ ...(await fejlSvar(kode, 'supabase').json()), pakning: 'venter' }, 502);
    }
  }
  log('pak', godkendt > 0 ? 'bogfoert' : 'kun_kasseret');
  return json({ data: { pakning, rackbeat: regulering, allerede: false }, kilde: 'supabase' }, 201);
}

/** Efter en fejl i Rackbeat (rb er null, hvis intet blev sendt til Rackbeat): blev reguleringen alligevel bogført, gælder pakningen ({id, pakning}). Findes den
 *  slet ikke, gives stk. tilbage til produktionslageret ('annulleret'). Ellers (kladde, eller Rackbeat svarer
 *  ikke) venter pakningen på et nyt forsøg med samme ref ('venter'), så stk. aldrig både står på
 *  produktionslageret og i Rackbeat. */
async function efterFejl(data, rb, ref) {
  try {
    const fundet = rb ? await rb.findRegulering(ref) : null;
    if (fundet && fundet.bogfoert) {
      return { id: fundet.id, pakning: await data.rpc('bekraeft_pakning', { ref, rackbeatId: fundet.id }) };
    }
    if (fundet) return 'venter';
    const { annulleret } = await data.rpc('annuller_pakning', { ref });
    return annulleret ? 'annulleret' : 'venter';
  } catch (e) {
    log('pak', 'efter_fejl_' + fejlkode(e), e && e.status);
    return 'venter';
  }
}
