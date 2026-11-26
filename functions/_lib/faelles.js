// Logikken bag /api/data (fælles data i Supabase) og /api/pak (pak fra produktionslageret til Rackbeat).
import { HOVEDLAGER, lavSkriveKlient, RackbeatFejl } from './rackbeat.js';
import { DataFejl, lavDataKlient } from './supabase.js';
import { enhed, historikForAendringer, pakFejlPost, pakPost } from './historik.js';
import { fejlSvar, fejlTekst, fraKalenderen, iDagIDanmark, json, log } from './svar.js';

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

/** Et produkt, der har batches, bestillinger eller pakninger (i databasen eller i samme kald), slettes ikke.
 *  Kalenderen tillader det ikke, men to kalendere kan ændre samtidig. */
function brugteFjernet(aendringer, nu) {
  const sletBatch = new Set(aendringer.batches.slet || []), sletRes = new Set(aendringer.reservationer.slet || []);
  const brugt = new Set([
    ...nu.batches.filter(b => !sletBatch.has(b.no)).map(b => b.pid),
    ...nu.reservationer.filter(r => !sletRes.has(r.id)).map(r => r.pid),
    ...nu.pakninger.map(k => k.pid),
    ...(aendringer.batches.gem || []).map(b => b.pid),
    ...(aendringer.reservationer.gem || []).map(r => r.pid),
  ]);
  return aendringer.produkter.slet.filter(id => !brugt.has(id));
}

/** POST /api/data: gemmer ændringer fra en kalender og sender alle data tilbage. */
export async function gemData({ request, env }, deps = {}) {
  if (!fraKalenderen(request)) return json({ fejl: 'Ugyldigt kald', kode: 'ugyldigt_kald' }, 403);
  const aendringer = laesAendringer(await laesKrop(request));
  if (!aendringer) return json({ fejl: 'Ugyldige data', kode: 'ugyldige_data' }, 400);
  try {
    const klient = db(env, deps);
    // Data før ændringen: til at se, hvad der er ændret (historik), og om et produkt stadig bruges
    const nu = await klient.rpc('hent_data', {});
    if (aendringer.produkter.slet && aendringer.produkter.slet.length) aendringer.produkter.slet = brugteFjernet(aendringer, nu);
    // Historikken skrives i samme transaktion som ændringen
    await klient.rpc('gem_data', { ...aendringer, historik: historikForAendringer(aendringer, nu, enhed(request)) });
    return dataSvar(await klient.rpc('hent_data', {}));
  } catch (e) {
    const kode = fejlkode(e);
    log('data', kode, e && e.status);
    return fejlSvar(kode, 'supabase');
  }
}

function laesPakning(k) {
  if (!erObjekt(k)) return null;
  const { ref, pid, sku, antal, kasseret = 0, navn } = k;
  if (typeof ref !== 'string' || !REF.test(ref) || !erTekst(pid) || typeof sku !== 'string' || !SKU.test(sku)) return null;
  if (!erHel(antal, 1, 10000) || !erHel(kasseret, 0, antal)) return null;
  // navn bruges kun i historikken
  return { ref, pid, sku, antal, kasseret, ...(erTekst(navn, 200) ? { navn } : {}) };
}

const labels = pakning => pakning.linjer.map(l => '#' + (l.label || l.batch)).join(', ');

/** Skriver i historikken. En fejl her må aldrig stoppe en pakning, så den logges kun. */
async function logHistorik(data, ...poster) {
  try { await data.rpc('log_historik', { poster }); }
  catch (e) { log('historik', fejlkode(e), e && e.status); }
}

const KATEGORIER = new Set(['batch', 'bestilling', 'produkt', 'person', 'pakning', 'fejl']);

/** GET /api/historik?foer=<id>&antal=<1-500>&kategori=<kategori>&soeg=<tekst>: nyeste først */
export async function hentHistorik({ request, env }, deps = {}) {
  const q = new URL(request.url).searchParams;
  const p = { antal: Math.min(500, Math.max(1, parseInt(q.get('antal'), 10) || 100)) };
  const foer = parseInt(q.get('foer'), 10);
  if (Number.isSafeInteger(foer) && foer > 0) p.foer = foer;
  if (KATEGORIER.has(q.get('kategori'))) p.kategori = q.get('kategori');
  const soeg = (q.get('soeg') || '').trim();
  if (soeg) p.soeg = soeg.slice(0, 80);
  try {
    return dataSvar(await db(env, deps).rpc('hent_historik', p));
  } catch (e) {
    const kode = fejlkode(e);
    log('historik', kode, e && e.status);
    return fejlSvar(kode, 'supabase');
  }
}

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
  const hvem = enhed(request), navn = k.navn;

  let data, pakning;
  try {
    data = db(env, deps);
    // Uden Rackbeat-nøgle reserveres intet
    if (!env.RACKBEAT_API_KEY) {
      await logHistorik(data, pakFejlPost(k, fejlTekst('ikke_sat_op'), 'afvist', { enhed: hvem, navn }));
      return fejlSvar('ikke_sat_op');
    }
    const { navn: _, ...felter } = k;
    pakning = await data.rpc('reserver_pakning', { ...felter, idag: dato });
  } catch (e) {
    const kode = fejlkode(e);
    if (kode === 'ikke_nok_klar') {
      const klar = Number(e.detalje) || 0;
      await logHistorik(data, pakFejlPost(k, `Der var kun ${klar} stk. klar til pakning`, 'afvist', { enhed: hvem, navn }));
      return json({ fejl: `Der er kun ${klar} stk. klar til pakning`, kode, klar }, 409);
    }
    log('pak', kode, e && e.status);
    if (data) await logHistorik(data, pakFejlPost(k, fejlTekst(kode, 'supabase'), 'afvist', { enhed: hvem, navn, detaljer: { kode } }));
    return fejlSvar(kode, 'supabase');
  }
  const igen = pakning.ny === false;
  if (pakning.status === 'bogfoert') {
    return json({ data: { pakning, rackbeat: null, allerede: true }, kilde: 'supabase' }, 200);
  }

  const godkendt = pakning.antal - pakning.kasseret;
  let rb = null, regulering = null, skrevet = false, foer = null;
  try {
    if (godkendt > 0) {
      rb = lavSkriveKlient({ noegle: env.RACKBEAT_API_KEY, ...deps.rackbeat });
      // Er reguleringen allerede bogført (et tidligere forsøg nåede igennem), oprettes den ikke igen.
      // En kladde fra et tidligere forsøg slettes: den ville sætte beholdningen ud fra lageret dengang.
      const fundet = await rb.findRegulering(pakning.ref, { sku: pakning.sku, dato: pakning.dato });
      skrevet = true;
      if (fundet && fundet.bogfoert) regulering = { id: fundet.id, antal: godkendt, lokation: HOVEDLAGER, dato };
      else {
        if (fundet) await rb.sletKladde(fundet.id);
        const r = await rb.laegTil({ sku: pakning.sku, antal: godkendt, dato,
          aarsag: `Pakket fra batch ${labels(pakning)}`, beskrivelse: `Produktionskalender, ref. ${pakning.ref}` });
        regulering = { id: r.id, antal: godkendt, lokation: HOVEDLAGER, dato };
        foer = r.foer ?? null;
        // Den bogførte ændring blev ikke præcis +godkendt (fx et salg i samme sekund): beholdningen skal tjekkes
        if (r.afviger){ regulering.advarsel = true; regulering.aendring = r.aendring; log('pak', 'afvigelse_i_rackbeat'); }
      }
    }
  } catch (e) {
    const kode = fejlkode(e);
    log('pak', 'rackbeat_' + kode, e && e.status);
    const udfald = await efterFejl(data, skrevet ? rb : null, pakning);
    if (!erObjekt(udfald)) {
      await logHistorik(data, pakFejlPost(pakning, fejlTekst(kode), udfald, { enhed: hvem, navn, detaljer: { kode, linjer: pakning.linjer } }));
      return json({ ...(await fejlSvar(kode).json()), pakning: udfald }, 502);
    }
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
      await logHistorik(data, pakFejlPost(pakning, `Lagt i Rackbeat${regulering ? ` (regulering ${regulering.id})` : ''}, men databasen svarede ikke bagefter: ${fejlTekst(kode, 'supabase')}`,
        'venter', { enhed: hvem, navn, detaljer: { kode, rackbeat: regulering } }));
      return json({ ...(await fejlSvar(kode, 'supabase').json()), pakning: 'venter' }, 502);
    }
  }
  log('pak', godkendt > 0 ? 'bogfoert' : 'kun_kasseret');
  await logHistorik(data, pakPost(pakning, regulering && { ...regulering, foer }, { igen, enhed: hvem, navn }));
  return json({ data: { pakning, rackbeat: regulering, allerede: false }, kilde: 'supabase' }, 201);
}

/** Efter en fejl i Rackbeat (rb er null, hvis intet blev sendt til Rackbeat): blev reguleringen alligevel bogført,
 *  gælder pakningen ({id, pakning}). Er den kun en kladde, slettes den (en kladde ændrer ikke beholdningen), og stk.
 *  gives tilbage til produktionslageret ('annulleret'), ligesom når den slet ikke findes. Svarer Rackbeat ikke,
 *  venter pakningen på et nyt forsøg med samme ref ('venter'), så stk. aldrig både står på produktionslageret og i Rackbeat. */
async function efterFejl(data, rb, pakning) {
  const ref = pakning.ref;
  try {
    const fundet = rb ? await rb.findRegulering(ref, { sku: pakning.sku, dato: pakning.dato }) : null;
    if (fundet && fundet.bogfoert) {
      return { id: fundet.id, pakning: await data.rpc('bekraeft_pakning', { ref, rackbeatId: fundet.id }) };
    }
    if (fundet) await rb.sletKladde(fundet.id);
    const { annulleret } = await data.rpc('annuller_pakning', { ref });
    return annulleret ? 'annulleret' : 'venter';
  } catch (e) {
    log('pak', 'efter_fejl_' + fejlkode(e), e && e.status);
    return 'venter';
  }
}
