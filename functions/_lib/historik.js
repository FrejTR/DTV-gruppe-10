// Historik til fejlfinding: serveren sammenligner data før og efter en ændring og skriver læsbare linjer
// (tabellen historik i Supabase). Hver linje: kategori, handling, emne (hvad), tekst (detaljer), de ændrede felter
// før og efter (detaljer) og enhed (browser og kalenderens id, så man kan se, hvilken computer det kom fra).

const MDR = ['jan.', 'feb.', 'mar.', 'apr.', 'maj', 'jun.', 'jul.', 'aug.', 'sep.', 'okt.', 'nov.', 'dec.'];
/** 2026-11-26 → 26. nov. 2026 */
export const dato = d => {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return d == null ? '–' : String(d);
  const [a, m, dg] = d.split('-').map(Number);
  return `${dg}. ${MDR[m - 1]} ${a}`;
};
const plusDage = (d, n) => {
  const t = new Date(d + 'T00:00:00Z');
  if (isNaN(t)) return null;
  t.setUTCDate(t.getUTCDate() + (Number(n) || 0));
  return t.toISOString().slice(0, 10);
};
const kort = (x, max = 300) => { const s = String(x); return s.length > max ? s.slice(0, max - 1) + '…' : s; };
const ens = (a, b) => JSON.stringify(sorter(a)) === JSON.stringify(sorter(b));
function sorter(x) {
  if (Array.isArray(x)) return x.map(sorter);
  if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map(k => [k, sorter(x[k])]));
  return x;
}
const vaerdi = v => v == null || v === '' ? '–' : typeof v === 'object' ? JSON.stringify(v) : String(v);

const TRIN = { demold: 'Taget ud af forme', trim: 'Kanter skåret' };
const TRIN_FORTRYD = { demold: 'Udtagning af forme fortrudt', trim: 'Kantskæring fortrudt' };
const STATUS = { aktiv: 'lavet', planlagt: 'planlagt', kasseret: 'fejlet' };

const labelOf = b => b.label == null ? String(b.no) : String(b.label).trim();
export const batchNavn = b => labelOf(b) ? '#' + labelOf(b) : 'uden nr.';

/** Browser og styresystem ud fra User-Agent, plus kalenderens id fra X-Kalender (tilfældigt id pr. browser). */
export function enhed(request) {
  const ua = request.headers.get('user-agent') || '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Ukendt browser';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'ukendt system';
  const id = request.headers.get('x-kalender') || '';
  return `${browser} på ${os}${/^[a-z0-9]{4,16}$/.test(id) ? ' · ' + id : ''}`;
}

/** Kun de felter, der er ændret, før og efter */
function felter(foer, efter, noegler) {
  const f = {}, e = {};
  for (const k of noegler) { f[k] = foer[k] ?? null; e[k] = efter[k] ?? null; }
  return { foer: f, efter: e };
}
/** De ændrede felter, i samme rækkefølge som orden (felter, der ikke står der, til sidst) */
const aendredeNoegler = (foer, efter, orden = {}) => {
  const plads = k => { const i = Object.keys(orden).indexOf(k); return i < 0 ? Infinity : i; };
  return [...new Set([...Object.keys(foer), ...Object.keys(efter)])].filter(k => !ens(foer[k], efter[k])).sort((a, b) => plads(a) - plads(b));
};

// ---------- batches ----------
const BATCH_FELT = { label: 'Batchnr.', pid: 'Produkt', qty: 'Antal', rejected: 'Kasserede', made: 'Dato', cure: 'Dage før pakning', by: 'Oprettet af', madeBy: 'Lavet af' };
// Felter, der beskrives på anden måde (status, trin, sæbespåner) eller kun siger hvem/hvornår (personen står i historikken)
const BATCH_STILLE = new Set(['no', 'rejectedOn', 'rejectedBy', 'packedOn', 'rackbeat', 'discardReason', 'steps', 'flakes', 'status', 'packed', 'rettet']);

function batchResume(b, navn) {
  const lavet = b.status === 'planlagt' ? `start ${dato(b.made)}` : `lavet ${dato(b.made)}`;
  return `${b.qty} stk. ${navn(b.pid)}, ${lavet}, ${b.cure} dage før pakning (pakkes ${dato(plusDage(b.made, b.cure))})${b.by ? `, oprettet af ${b.by}` : ''}${b.madeBy ? `, lavet af ${b.madeBy}` : ''}`;
}
const aarsag = r => r && typeof r === 'object' ? [r.kategori, r.tekst].filter(Boolean).join(': ') : '';

export function batchPost(foer, efter, ctx) {
  const b = efter || foer;
  const emne = `${batchNavn(b)} · ${ctx.navn(b.pid)}`;
  if (!foer) {
    const handling = efter.status === 'planlagt' ? 'Batch planlagt' : efter.status === 'kasseret' ? 'Batch oprettet som fejlet' : 'Batch registreret som lavet';
    return { kategori: 'batch', handling, emne, tekst: batchResume(efter, ctx.navn), detaljer: { efter } };
  }
  if (!efter) {
    const linjer = ctx.pakningslinjer(foer.no);
    const pakket = linjer.reduce((s, l) => s + l.antal, 0);
    const tekst = batchResume(foer, ctx.navn) + `. Status: ${STATUS[foer.status] || foer.status}.`
      + (pakket ? ` Der var pakket ${pakket} stk. fra den (${linjer.length} pakning${linjer.length === 1 ? '' : 'er'}). Pakningerne er fjernet i kalenderen, men det, der er lagt på lager i Rackbeat, er ikke ændret.` : '');
    return { kategori: 'batch', handling: 'Batch slettet', emne, tekst, detaljer: { foer } };
  }
  const noegler = aendredeNoegler(foer, efter, BATCH_FELT);
  if (!noegler.length) return null;
  const handlinger = [], dele = [];
  if (foer.status !== efter.status) {
    if (foer.status === 'planlagt' && efter.status === 'aktiv') handlinger.push('Batch registreret som lavet');
    else if (efter.status === 'kasseret') { handlinger.push('Batch markeret som fejlet'); if (aarsag(efter.discardReason)) dele.push(`Årsag: ${aarsag(efter.discardReason)}`); }
    else if (foer.status === 'kasseret') handlinger.push('Batch gendannet');
    else handlinger.push(`Status ændret fra ${STATUS[foer.status] || foer.status} til ${STATUS[efter.status] || efter.status}`);
  } else if (!ens(foer.discardReason, efter.discardReason) && efter.discardReason) {
    handlinger.push('Årsag til fejl ændret'); dele.push(`Årsag: ${aarsag(efter.discardReason)}`);
  }
  const fs = foer.steps || {}, es = efter.steps || {};
  for (const k of new Set([...Object.keys(fs), ...Object.keys(es)])) {
    if (!fs[k] && es[k]) { handlinger.push(TRIN[k] || `Trin ${k} registreret`); dele.push(`${TRIN[k] || k} ${dato(es[k].on)}${es[k].by ? ' af ' + es[k].by : ''}`); }
    else if (fs[k] && !es[k]) handlinger.push(TRIN_FORTRYD[k] || `Trin ${k} fortrudt`);
    else if (!ens(fs[k], es[k])) { handlinger.push(`${TRIN[k] || k} ændret`); dele.push(`${TRIN[k] || k} ${dato(es[k].on)}${es[k].by ? ' af ' + es[k].by : ''}`); }
  }
  if (!ens(foer.flakes, efter.flakes) && efter.flakes) {
    const ny = (efter.flakes.qty || 0) - ((foer.flakes && foer.flakes.qty) || 0);
    const brugt = (efter.flakes.made || 0) - ((foer.flakes && foer.flakes.made) || 0);
    handlinger.push(brugt > 0 ? 'Sæbespåner lavet' : 'Kasserede ikke brugt til sæbespåner');
    dele.push(`${brugt > 0 ? `Sæbespåner af ${brugt} stk.` : `${ny} stk. ikke brugt`}${efter.flakes.by ? ' af ' + efter.flakes.by : ''}`);
  }
  if (!!foer.packed !== !!efter.packed) handlinger.push(efter.packed ? 'Hele batchen markeret som pakket' : 'Pakket fortrudt');
  for (const k of noegler) {
    if (BATCH_STILLE.has(k)) continue;
    const f = k === 'pid' ? ctx.navn(foer[k]) : k === 'made' ? dato(foer[k]) : vaerdi(foer[k]);
    const e = k === 'pid' ? ctx.navn(efter[k]) : k === 'made' ? dato(efter[k]) : vaerdi(efter[k]);
    dele.push(`${BATCH_FELT[k] || k}: ${f} → ${e}`);
  }
  if (!handlinger.length && !dele.length) return null;
  return { kategori: 'batch', handling: handlinger.length ? handlinger.join(', ') : 'Batch ændret', emne,
    tekst: dele.join('. '), detaljer: felter(foer, efter, noegler) };
}

// ---------- bestillinger og events ----------
const RES_FELT = { kind: 'Type', who: 'Hvem', pid: 'Produkt', qty: 'Antal', date: 'Dato', note: 'Note' };
const resType = r => r.kind === 'event' ? 'Event' : 'Forudbestilling';

export function reservationPost(foer, efter, ctx) {
  const r = efter || foer;
  const emne = r.who || '–';
  const resume = x => `${x.qty} stk. ${ctx.navn(x.pid)} til ${dato(x.date)}`;
  if (!foer) return { kategori: 'bestilling', handling: `${resType(r)} oprettet`, emne, tekst: resume(efter), detaljer: { efter } };
  if (!efter) return { kategori: 'bestilling', handling: `${resType(r)} slettet`, emne, tekst: resume(foer), detaljer: { foer } };
  const noegler = aendredeNoegler(foer, efter, RES_FELT).filter(k => k !== 'id' && k !== 'group' && k !== 'by');
  if (!noegler.length) return null;
  const dele = noegler.map(k => {
    const f = k === 'pid' ? ctx.navn(foer[k]) : k === 'date' ? dato(foer[k]) : k === 'kind' ? resType(foer) : vaerdi(foer[k]);
    const e = k === 'pid' ? ctx.navn(efter[k]) : k === 'date' ? dato(efter[k]) : k === 'kind' ? resType(efter) : vaerdi(efter[k]);
    return `${RES_FELT[k] || k}: ${f} → ${e}`;
  });
  return { kategori: 'bestilling', handling: `${resType(r)} ændret`, emne, tekst: dele.join('. '), detaljer: felter(foer, efter, noegler) };
}

// ---------- produkter ----------
const PROD_FELT = { name: 'Navn', sku: 'Varenr.', type: 'Type', min: 'Minimum', batch: 'Batchstørrelse', cure: 'Dage før pakning', steps: 'Trin', kanter: 'Skær kanter og sæbespåner' };
const jaNej = v => v === false ? 'nej' : 'ja';   // Uden valg er det slået til
const trinTekst = s => Array.isArray(s) && s.length ? s.map(x => x && typeof x === 'object' ? `${TRIN[x.key] || x.key} dag ${x.day}` : String(x)).join(', ') : 'ingen';

export function produktPost(foer, efter) {
  const p = efter || foer;
  const emne = `${p.name}${p.sku ? ` (${p.sku})` : ''}`;
  const resume = x => `${x.type || '–'}, minimum ${x.min ?? '–'}, batchstørrelse ${x.batch ?? '–'}, ${x.cure ?? '–'} dage før pakning`;
  if (!foer) return { kategori: 'produkt', handling: 'Produkt oprettet', emne, tekst: resume(efter), detaljer: { efter } };
  if (!efter) return { kategori: 'produkt', handling: 'Produkt slettet', emne, tekst: resume(foer), detaljer: { foer } };
  const noegler = aendredeNoegler(foer, efter, PROD_FELT).filter(k => k !== 'id');
  if (!noegler.length) return null;
  const handlinger = [], dele = [];
  if (!!foer.archived !== !!efter.archived) handlinger.push(efter.archived ? 'Produkt arkiveret' : 'Produkt gendannet');
  for (const k of noegler) {
    if (k === 'archived') continue;
    dele.push(k === 'steps' ? `Trin: ${trinTekst(foer.steps)} → ${trinTekst(efter.steps)}`
      : k === 'kanter' ? `${PROD_FELT.kanter}: ${jaNej(foer.kanter)} → ${jaNej(efter.kanter)}`
      : `${PROD_FELT[k] || k}: ${vaerdi(foer[k])} → ${vaerdi(efter[k])}`);
  }
  return { kategori: 'produkt', handling: handlinger.length ? handlinger.join(', ') : 'Produkt ændret', emne,
    tekst: dele.join('. '), detaljer: felter(foer, efter, noegler) };
}

/** Linjer for ændringerne fra en kalender. nu er data før ændringen (hent_data). Batches, som databasen ikke
 *  sletter (en pakning venter på Rackbeat), og produkter, der ikke slettes (bruges stadig), kommer ikke med. */
export function historikForAendringer(aendringer, nu, enhedTekst, person = null) {
  const produkter = new Map(nu.produkter.map(p => [p.id, p]));
  for (const p of aendringer.produkter.gem || []) if (!produkter.has(p.id)) produkter.set(p.id, p);
  const ctx = {
    navn: pid => (produkter.get(pid) || {}).name || pid || '–',
    pakningslinjer: no => nu.pakninger.flatMap(k => k.linjer.filter(l => l.batch === no)),
  };
  const venter = new Set(nu.pakninger.filter(k => k.status === 'reserveret').flatMap(k => k.linjer.map(l => l.batch)));
  const poster = [];
  const par = (liste, noegle, aendr, lav, ikkeSlet = () => false) => {
    const foer = new Map(liste.map(x => [String(x[noegle]), x]));
    for (const x of aendr.gem || []) poster.push(lav(foer.get(String(x[noegle])) || null, x, ctx));
    for (const n of aendr.slet || []) { const f = foer.get(String(n)); if (f && !ikkeSlet(n)) poster.push(lav(f, null, ctx)); }
  };
  par(nu.batches, 'no', aendringer.batches, batchPost, n => venter.has(n));
  par(nu.reservationer, 'id', aendringer.reservationer, reservationPost);
  par(nu.produkter, 'id', aendringer.produkter, produktPost);
  for (const navn of (aendringer.personer.gem || []).filter(n => !nu.personer.includes(n))) {
    poster.push({ kategori: 'person', handling: 'Person tilføjet', emne: navn, tekst: `${navn} kan nu vælges som den, der laver eller planlægger batches.` });
  }
  return poster.filter(Boolean).map(p => ({ ...p, handling: kort(p.handling, 200), emne: kort(p.emne, 300), tekst: kort(p.tekst || '', 4000), enhed: enhedTekst, person }));
}

// ---------- pakning ----------
const pakEmne = (k, navn) => navn ? `${navn}${k.sku ? ` (${k.sku})` : ''}` : (k.sku || k.pid);
const linjeTekst = linjer => linjer.map(l => `${'#' + (l.label || l.batch)}: ${l.antal} stk.${l.kasseret ? ` (${l.kasseret} kasseret)` : ''}`).join(', ');

/** Pakket færdig: stk. taget ud af produktionslageret og (de godkendte) lagt på Hovedlager i Rackbeat */
export function pakPost(pakning, regulering, { igen = false, enhed: enhedTekst, navn, person = null } = {}) {
  const godkendt = pakning.antal - pakning.kasseret;
  let tekst = `${pakning.antal} stk. taget ud af produktionslageret${pakning.kasseret ? `, heraf ${pakning.kasseret} kasseret` : ''}. Fra batch ${linjeTekst(pakning.linjer).replace(/\.$/, '')}.`;
  if (godkendt > 0 && regulering) {
    tekst += ` Lagt på Hovedlager i Rackbeat: ${godkendt} stk. (regulering ${regulering.id}`;
    if (regulering.foer != null) tekst += `, beholdning ${regulering.foer} → ${regulering.foer + (regulering.aendring ?? godkendt)}`;
    tekst += ').';
    if (regulering.advarsel) tekst += ` Advarsel: Rackbeat ændrede beholdningen med ${regulering.aendring} i stedet for ${godkendt}. Tjek beholdningen i Rackbeat.`;
  } else if (godkendt === 0) tekst += ' Alle var kasseret, så intet er lagt på lager i Rackbeat.';
  if (igen) tekst += ' (Nyt forsøg efter en fejl.)';
  return {
    kategori: 'pakning', handling: regulering && regulering.advarsel ? 'Pakket, med advarsel fra Rackbeat' : 'Pakket og lagt i Rackbeat',
    emne: pakEmne(pakning, navn), tekst,
    detaljer: { ref: pakning.ref, pid: pakning.pid, sku: pakning.sku, antal: pakning.antal, kasseret: pakning.kasseret, linjer: pakning.linjer, rackbeat: regulering || null },
    enhed: enhedTekst, person,
  };
}

/** Noget gik galt ved en pakning. udfald: 'venter' (stk. er taget ud og venter på et nyt forsøg), 'annulleret'
 *  (stk. er tilbage på produktionslageret), 'afvist' (intet skete) */
export function pakFejlPost(k, fejltekst, udfald, { enhed: enhedTekst, navn, person = null, detaljer = {} } = {}) {
  const hvad = udfald === 'venter' ? 'Stk. er taget ud af produktionslageret og venter på et nyt forsøg.'
    : udfald === 'annulleret' ? 'Intet er lagt på lager i Rackbeat, og stk. er tilbage på produktionslageret.'
    : 'Intet er taget ud af produktionslageret.';
  return {
    kategori: 'fejl', handling: 'Pakning fejlede', emne: pakEmne(k, navn),
    tekst: `${k.antal} stk.${k.kasseret ? ` (${k.kasseret} kasseret)` : ''}: ${fejltekst}. ${hvad}`,
    detaljer: { ref: k.ref, pid: k.pid, sku: k.sku, antal: k.antal, kasseret: k.kasseret, udfald, ...detaljer },
    enhed: enhedTekst, person,
  };
}
