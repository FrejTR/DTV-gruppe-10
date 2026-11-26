// Test af /api/data og /api/pak mod en rigtig Postgres (PGlite) med migrationerne og en falsk Rackbeat.
// Ingen rigtige nøgler. Kørsel: node --test "tests/*.test.mjs"
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as dataRute from '../api/data.mjs';
import * as pakRute from '../api/pak.mjs';
import * as historikRute from '../api/historik.mjs';
import { gemData, hentData, hentHistorik, pak } from '../functions/_lib/faelles.js';
import { lavDatabase, supabaseFetch } from './supabase_pglite.mjs';

const DB_NOEGLE = 'sb_secret_test-noegle-456';
const RB_NOEGLE = 'hemmelig-rackbeat-noegle-123';
const ENV = { SUPABASE_URL: 'https://projekt.supabase.co', SUPABASE_SECRET_KEY: DB_NOEGLE, RACKBEAT_API_KEY: RB_NOEGLE };
const ORIGIN = 'https://kalender.example.com';
const NU = Date.parse('2026-11-16T11:00:00Z');   // 16. november 2026 kl. 12 dansk tid

let logs;
const originalError = console.error;
beforeEach(() => { logs = []; console.error = (...a) => logs.push(a.join(' ')); });
afterEach(() => { console.error = originalError; });

const krop = async svar => JSON.parse(await svar.clone().text());
async function ingenHemmeligheder(svar) {
  const tekst = await svar.clone().text();
  for (const s of [DB_NOEGLE, RB_NOEGLE, 'Bearer']) {
    assert.ok(!tekst.includes(s), `svaret indeholder ${s}`);
    assert.ok(!logs.join('\n').includes(s), `loggen indeholder ${s}`);
  }
}

function anmodning(sti, k, { origin = ORIGIN, type = 'application/json', metode = 'POST', ekstra = {} } = {}) {
  const hoveder = { ...ekstra };
  if (origin) hoveder.Origin = origin;
  if (type) hoveder['Content-Type'] = type;
  return new Request(ORIGIN + sti, { method: metode, headers: hoveder, ...(metode === 'POST' ? { body: typeof k === 'string' ? k : JSON.stringify(k) } : {}) });
}

/** Falsk Rackbeat til skrivning med lager, der opfører sig som den rigtige Rackbeat (afprøvet 16. november 2026):
 *  regulate_difference false SÆTTER beholdningen til antallet ved bogføring, og linjen viser derefter ændringen.
 *  Listen viser kun kladder, medmindre is_booked=true. Hukommelse, så et nyt forsøg kan se, hvad der skete første gang.
 *  fejl: {find, lager, opret, hent, slet, bogfoer} = HTTP-status eller 'net'. tabtSvar: bogføringen sker, men svaret går tabt.
 *  fejlFra: alle kald fra og med dette nummer (1, 2, ...) giver netværksfejl. salgUndervejs: solgt mellem læsning og bogføring. */
function falskRackbeat({ fejl = {}, tabtSvar = false, fejlFra = Infinity, salgUndervejs = 0, lager = { HAT003: 24 } } = {}) {
  const kald = [], reguleringer = [], beholdning = { ...lager };
  let id = 5000;
  const svar = (krop, status) => new Response(JSON.stringify(krop), { status });
  const hent = async (url, init = {}) => {
    const u = new URL(url), metode = init.method || 'GET', sti = u.pathname;
    const k = init.body ? JSON.parse(init.body) : null;
    const en = /\/inventory-adjustments\/(\d+)/.exec(sti);
    const hvad = sti.endsWith('/locations') ? 'lager' : metode === 'DELETE' ? 'slet' : metode === 'GET' ? (en ? 'hent' : 'find') : sti.endsWith('/book') ? 'bogfoer' : 'opret';
    kald.push({ hvad, sti, krop: k, auth: init.headers && init.headers.Authorization });
    const f = kald.length >= fejlFra ? 'net' : fejl[hvad];
    if (f === 'net') throw new TypeError('fetch failed');
    if (f) return svar({ errors: { message: 'nej ' + RB_NOEGLE } }, f);
    const r = en && reguleringer.find(x => x.id === Number(en[1]));
    if (hvad === 'lager') return svar({ product_locations: [{ number: 1001, stock_quantity: beholdning[decodeURIComponent(sti.split('/')[3])] ?? 0 }, { number: 1002, stock_quantity: 7 }] }, 200);
    if (hvad === 'find') return svar({ inventory_regulations: reguleringer.filter(x => x.is_booked === (u.searchParams.get('is_booked') === 'true')).reverse() }, 206);
    if (hvad === 'hent') return svar({ inventory_regulation: r }, 200);
    if (hvad === 'slet') { reguleringer.splice(reguleringer.indexOf(r), 1); return new Response('', { status: 200 }); }
    if (hvad === 'opret') {
      const ny = { id: ++id, is_booked: false, regulate_difference: !!k.regulate_diff, description: k.description, krop: k,
        lines: [{ child_id: k.item_id, quantity: Number(k.quantity) }] };
      reguleringer.push(ny);
      return svar({ inventory_regulation: { id: ny.id, is_booked: false } }, 201);
    }
    const l = r.lines[0];
    beholdning[l.child_id] = (beholdning[l.child_id] ?? 0) - salgUndervejs;
    const aendring = r.regulate_difference ? l.quantity : l.quantity - beholdning[l.child_id];
    beholdning[l.child_id] += aendring; l.quantity = aendring; r.is_booked = true;
    if (tabtSvar) throw new TypeError('fetch failed');
    return new Response('', { status: 200 });
  };
  return { hent, kald, reguleringer, beholdning };
}

async function opsaet(rbValg) {
  const db = await lavDatabase();
  const rb = falskRackbeat(rbValg);
  const deps = { nu: () => NU, db: { fetch: supabaseFetch(db, DB_NOEGLE) }, rackbeat: { fetch: rb.hent } };
  return { db, rb, deps };
}

const B = (no, label, made, qty, ekstra = {}) => ({ no, label, by: 'Anna', pid: 'havtorn-saebe', qty, made, cure: 22, status: 'aktiv', ...ekstra });
// Klar 16. nov.: #1 (40) og #2 (30 - 5 kasseret = 25). #3 er lavet 10. nov. og hærder stadig.
const TRE_BATCHES = { batches: { gem: [B(1, '1', '2026-10-01', 40), B(2, '2', '2026-10-05', 30, { rejected: 5 }), B(3, '3', '2026-11-10', 60)] } };
const PAK = (antal, kasseret = 0, ref = 'pak-aaaaaaaa') => ({ ref, pid: 'havtorn-saebe', sku: 'HAT003', antal, kasseret });

async function medData(deps, aendringer = TRE_BATCHES) {
  const svar = await gemData({ request: anmodning('/api/data', aendringer), env: ENV }, deps);
  assert.equal(svar.status, 200, await svar.clone().text());
  return (await krop(svar)).data;
}
const lager = async deps => (await krop(await hentData({ env: ENV }, deps))).data;

// ---------- /api/data ----------

test('data: tom database giver tomme lister', async () => {
  const { deps } = await opsaet();
  const svar = await hentData({ env: ENV }, deps);
  assert.equal(svar.status, 200);
  const b = await krop(svar);
  assert.deepEqual(b.data, { personer: [], produkter: [], batches: [], reservationer: [], pakninger: [] });
  assert.equal(b.kilde, 'supabase');
  await ingenHemmeligheder(svar);
});

test('data: gemmer, opdaterer og sletter, og sender alle data tilbage', async () => {
  const { deps } = await opsaet();
  await medData(deps, {
    ...TRE_BATCHES,
    reservationer: { gem: [{ id: 'r1-0', group: 'r1', kind: 'Bestilling', who: 'Butik', pid: 'havtorn-saebe', qty: 10, date: '2026-11-20' }] },
    produkter: { gem: [{ id: 'havtorn-saebe', name: 'Havtorn sæbe bar', sku: 'HAT003', type: 'Sæbebarer', min: 50, batch: 65, cure: 22, steps: [], count: 62, rate: 9, lagerHentet: 'x', salgstempo: {} }] },
    personer: { gem: ['Anna', ' Mette '] },
  });
  const d = await medData(deps, { batches: { gem: [B(1, '1a', '2026-10-01', 41)], slet: [3] }, reservationer: { slet: ['r1-0'] } });
  assert.deepEqual(d.batches.map(b => [b.no, b.label, b.qty]), [[1, '1a', 41], [2, '2', 30]]);
  assert.deepEqual(d.reservationer, []);
  assert.deepEqual(d.personer, ['Anna', 'Mette']);
  assert.deepEqual(Object.keys(d.produkter[0]).sort(), ['batch', 'cure', 'id', 'min', 'name', 'sku', 'steps', 'type'],
    'lager og salgstempo fra Rackbeat deles ikke');
});

test('data: et ubrugt produkt kan slettes, men ikke et produkt med batches, bestillinger eller pakninger', async () => {
  const { deps } = await opsaet();
  const P = id => ({ id, name: id, sku: id.toUpperCase().slice(0, 6), type: 'Andet', min: 0, batch: 10, cure: 1, steps: [] });
  await medData(deps, {
    ...TRE_BATCHES,
    produkter: { gem: [P('havtorn-saebe'), P('ny-vare'), P('bestilt'), P('pakket')] },
    reservationer: { gem: [{ id: 'r1-0', pid: 'bestilt', qty: 5, date: '2026-12-01' }] },
  });
  await medData(deps, { batches: { gem: [B(7, '7', '2026-10-01', 10, { pid: 'pakket' })] } });
  await pak({ request: anmodning('/api/pak', { ref: 'pak-cccccccc', pid: 'pakket', sku: 'PAKKET', antal: 3, kasseret: 3 }), env: ENV }, deps);
  // Sletningen af batch 3 og produktet i samme kald: produktet har stadig batch 1 og 2
  let d = await medData(deps, { produkter: { slet: ['ny-vare', 'havtorn-saebe', 'bestilt', 'pakket'] }, batches: { slet: [3] } });
  assert.deepEqual(d.produkter.map(p => p.id).sort(), ['bestilt', 'havtorn-saebe', 'pakket'], 'kun det ubrugte produkt er slettet');
  // Er bestillingen slettet i samme kald, må produktet slettes
  d = await medData(deps, { produkter: { slet: ['bestilt'] }, reservationer: { slet: ['r1-0'] } });
  assert.ok(!d.produkter.some(p => p.id === 'bestilt'));
  // En ny batch i samme kald forhindrer sletningen
  d = await medData(deps, { produkter: { gem: [P('ny-vare')] } });
  d = await medData(deps, { produkter: { slet: ['ny-vare'] }, batches: { gem: [B(8, '8', '2026-11-01', 10, { pid: 'ny-vare' })] } });
  assert.ok(d.produkter.some(p => p.id === 'ny-vare'));
});

test('data: kald fra en anden side eller uden JSON afvises (CSRF)', async () => {
  const { deps } = await opsaet();
  for (const opt of [{ origin: 'https://ond.example.com' }, { origin: null }, { type: 'text/plain' }]) {
    const svar = await gemData({ request: anmodning('/api/data', TRE_BATCHES, opt), env: ENV }, deps);
    assert.equal(svar.status, 403, JSON.stringify(opt));
  }
  assert.deepEqual((await lager(deps)).batches, []);
});

test('data: ugyldige data afvises, så produktionslageret altid kan regnes', async () => {
  const { deps } = await opsaet();
  const forkerte = [
    { batches: { gem: [B(1, '1', '2026-13-01', 40)] } }, { batches: { gem: [B(1, '1', '1. okt', 40)] } },
    { batches: { gem: [B(1, '1', '2026-10-01', '40')] } }, { batches: { gem: [B(1, '1', '2026-10-01', 40, { rejected: 41 })] } },
    { batches: { gem: [B(0, '1', '2026-10-01', 40)] } }, { batches: { gem: [B(1.5, '1', '2026-10-01', 40)] } },
    { batches: { gem: [B(1, '1', '2026-10-01', 40, { status: 'pakket' })] } }, { batches: { gem: [B(1, '1', '2026-10-01', 40, { cure: -1 })] } },
    { batches: { gem: [B(1, '1', '2026-10-01', 40, { note: 'x'.repeat(5000) })] } }, { batches: { slet: ['1'] } },
    { reservationer: { gem: [{ id: 'r', pid: 'p', qty: 1, date: 'i morgen' }] } }, { personer: { gem: [''] } },
    { personer: ['Anna'] }, { hemmeligt: {} }, [TRE_BATCHES], '{ups', 'x'.repeat(1024 * 1024 + 1),
  ];
  for (const k of forkerte) {
    const svar = await gemData({ request: anmodning('/api/data', k), env: ENV }, deps);
    assert.equal(svar.status, 400, JSON.stringify(k).slice(0, 120));
  }
  assert.deepEqual((await lager(deps)).batches, []);
});

test('data: manglende opsætning giver 503, forkert nøgle 502 uden nøglen i svaret', async () => {
  const { deps } = await opsaet();
  let svar = await hentData({ env: { RACKBEAT_API_KEY: RB_NOEGLE } }, deps);
  assert.equal(svar.status, 503);
  assert.equal((await krop(svar)).kode, 'db_ikke_sat_op');
  svar = await hentData({ env: { ...ENV, SUPABASE_SECRET_KEY: 'forkert' } }, deps);
  assert.equal(svar.status, 502);
  assert.equal((await krop(svar)).kode, 'db_noegle_afvist');
  svar = await hentData({ env: ENV }, { db: { fetch: async () => { throw new TypeError('fetch failed'); } } });
  assert.equal((await krop(svar)).kode, 'db_ingen_forbindelse');
  await ingenHemmeligheder(svar);
});

// ---------- /api/pak ----------

test('pak: 22 stk. med 2 kasseret tages fra ældste batch, og 20 lægges på Hovedlager og bogføres', async () => {
  const { rb, deps } = await opsaet();
  await medData(deps);
  const svar = await pak({ request: anmodning('/api/pak', PAK(22, 2)), env: ENV }, deps);
  assert.equal(svar.status, 201, await svar.clone().text());
  const b = (await krop(svar)).data;
  assert.equal(b.pakning.status, 'bogfoert');
  assert.deepEqual(b.pakning.linjer, [{ batch: 1, label: '1', antal: 22, kasseret: 2 }]);
  assert.deepEqual(b.rackbeat, { id: 5001, antal: 20, lokation: 1001, dato: '2026-11-16' });
  assert.equal(rb.beholdning.HAT003, 44, '24 på lager + 20 godkendt = 44. Lageret må aldrig blive sat til 20');
  assert.equal(rb.reguleringer[0].lines[0].quantity, 20, 'den bogførte ændring er +20');
  assert.deepEqual(rb.kald.map(k => k.hvad), ['find', 'find', 'lager', 'opret', 'bogfoer', 'hent'],
    'søger bogførte og kladder, læser lageret, opretter, bogfører og kontrollerer');
  const opret = rb.kald.find(k => k.hvad === 'opret');
  assert.deepEqual(opret.krop, { regulated_at: '2026-11-16', reason: 'Pakket fra batch #1', description: 'Produktionskalender, ref. pak-aaaaaaaa',
    adjustment_type: 'quantity', item_id: 'HAT003', location: 1001, quantity: '44', regulation_type: 1004, regulate_diff: false });
  assert.ok(rb.kald.every(k => k.auth === `Bearer ${RB_NOEGLE}`));
  const d = await lager(deps);
  assert.deepEqual(d.pakninger.map(p => [p.ref, p.status, p.rackbeatId, p.antal, p.kasseret]), [['pak-aaaaaaaa', 'bogfoert', 5001, 22, 2]]);
  await ingenHemmeligheder(svar);
});

test('pak: over flere batches, ældste først. Kun hærdede batches kan pakkes', async () => {
  const { rb, deps } = await opsaet();
  await medData(deps);
  let svar = await pak({ request: anmodning('/api/pak', PAK(50)), env: ENV }, deps);
  assert.equal(svar.status, 201);
  assert.deepEqual((await krop(svar)).data.pakning.linjer.map(l => [l.batch, l.antal]), [[1, 40], [2, 10]]);
  assert.equal(rb.kald.find(k => k.hvad === 'opret').krop.reason, 'Pakket fra batch #1, #2');
  assert.equal(rb.beholdning.HAT003, 74, '24 + 50');
  svar = await pak({ request: anmodning('/api/pak', PAK(16, 0, 'pak-bbbbbbbb')), env: ENV }, deps);
  assert.equal(svar.status, 409, 'batch #3 hærder stadig, så der er kun 15 klar');
  const b = await krop(svar);
  assert.equal(b.kode, 'ikke_nok_klar'); assert.equal(b.klar, 15);
  assert.equal(rb.kald.length, 6, 'intet sendt til Rackbeat');
});

test('pak: samme ref igen tager ikke stk. ud to gange og sender intet til Rackbeat', async () => {
  const { rb, deps } = await opsaet();
  await medData(deps);
  await pak({ request: anmodning('/api/pak', PAK(22, 2)), env: ENV }, deps);
  const svar = await pak({ request: anmodning('/api/pak', PAK(22, 2)), env: ENV }, deps);
  assert.equal(svar.status, 200);
  assert.equal((await krop(svar)).data.allerede, true);
  assert.equal(rb.kald.length, 6);
  assert.equal(rb.beholdning.HAT003, 44, 'kun lagt til én gang');
  assert.equal((await lager(deps)).pakninger.length, 1);
});

test('pak: alle kasseret giver ingen regulering i Rackbeat', async () => {
  const { rb, deps } = await opsaet();
  await medData(deps);
  const svar = await pak({ request: anmodning('/api/pak', PAK(3, 3)), env: ENV }, deps);
  assert.equal(svar.status, 201);
  const b = (await krop(svar)).data;
  assert.equal(b.rackbeat, null); assert.equal(b.pakning.status, 'bogfoert');
  assert.equal(rb.kald.length, 0);
});

test('pak: afvist i Rackbeat giver stk. tilbage til produktionslageret', async () => {
  for (const fejl of [{ opret: 422 }, { opret: 403 }, { find: 401 }, { find: 'net' }, { lager: 404 }, { bogfoer: 500 }, { bogfoer: 422 }]) {
    const { rb, deps } = await opsaet({ fejl });
    await medData(deps);
    const svar = await pak({ request: anmodning('/api/pak', PAK(22)), env: ENV }, deps);
    assert.equal(svar.status, 502, JSON.stringify(fejl));
    assert.equal((await krop(svar)).pakning, 'annulleret', JSON.stringify(fejl));
    assert.deepEqual((await lager(deps)).pakninger, []);
    assert.ok(rb.kald.filter(k => k.hvad === 'opret').length <= 1, 'et POST sendes aldrig to gange');
    assert.equal(rb.beholdning.HAT003, 24, 'lageret i Rackbeat er urørt');
    assert.equal(rb.reguleringer.length, 0, 'en kladde, der ikke blev bogført, er slettet');
    await ingenHemmeligheder(svar);
  }
});

test('pak: et salg i samme sekund giver en advarsel, så beholdningen kan tjekkes', async () => {
  const { rb, deps } = await opsaet({ salgUndervejs: 1 });
  await medData(deps);
  const svar = await pak({ request: anmodning('/api/pak', PAK(22, 2)), env: ENV }, deps);
  assert.equal(svar.status, 201);
  const r = (await krop(svar)).data.rackbeat;
  assert.equal(r.advarsel, true); assert.equal(r.aendring, 21);
});

test('pak: svarer Rackbeat ikke efter oprettelsen, venter pakningen. Et nyt forsøg laver kladden om ud fra lageret nu', async () => {
  // Kald 5 er bogføringen: den og alt derefter fejler
  const { rb, deps } = await opsaet({ fejlFra: 5 });
  await medData(deps);
  let svar = await pak({ request: anmodning('/api/pak', PAK(22)), env: ENV }, deps);
  assert.equal(svar.status, 502);
  assert.equal((await krop(svar)).pakning, 'venter');
  let d = await lager(deps);
  assert.equal(d.pakninger[0].status, 'reserveret', 'stk. er stadig taget ud, så de ikke kan pakkes to gange');
  // Rackbeat virker igen, og der er solgt 4 i mellemtiden. Den gamle kladde (sæt til 46) må ikke bogføres.
  const igen = falskRackbeatMed(rb, { HAT003: 20 });
  svar = await pak({ request: anmodning('/api/pak', PAK(22)), env: ENV }, { ...deps, rackbeat: { fetch: igen.hent } });
  assert.equal(svar.status, 201, await svar.clone().text());
  assert.equal(igen.beholdning.HAT003, 42, '20 på lager nu + 22');
  assert.equal(igen.reguleringer.length, 1, 'den gamle kladde er slettet, kun én regulering');
  assert.equal(igen.reguleringer[0].is_booked, true);
  d = await lager(deps);
  assert.equal(d.pakninger[0].status, 'bogfoert');
});

/** Samme reguleringer som rb, men uden fejl, og med et nyt lager */
function falskRackbeatMed(rb, lager) {
  const ny = falskRackbeat({ lager });
  ny.reguleringer.push(...rb.reguleringer);
  return ny;
}

test('pak: bogført, men svaret gik tabt, tæller som pakket', async () => {
  const { rb, deps } = await opsaet({ tabtSvar: true });
  await medData(deps);
  const svar = await pak({ request: anmodning('/api/pak', PAK(22)), env: ENV }, deps);
  assert.equal(svar.status, 201, await svar.clone().text());
  assert.equal((await krop(svar)).data.pakning.status, 'bogfoert');
  assert.equal(rb.reguleringer.length, 1);
  assert.equal(rb.beholdning.HAT003, 46, 'lagt til én gang');
});

test('pak: to samtidige pakninger kan ikke tage de samme stk.', async () => {
  const { deps } = await opsaet();
  await medData(deps);
  const svar = await Promise.all([PAK(40, 0, 'pak-aaaaaaaa'), PAK(40, 0, 'pak-bbbbbbbb')]
    .map(k => pak({ request: anmodning('/api/pak', k), env: ENV }, deps)));
  assert.deepEqual(svar.map(s => s.status).sort(), [201, 409]);
});

test('pak: ugyldige kald afvises uden at røre databasen eller Rackbeat', async () => {
  const { rb, deps } = await opsaet();
  await medData(deps);
  const forkerte = [PAK(0), PAK(2.5), PAK('22'), PAK(22, 23), PAK(22, -1), { ...PAK(22), ref: 'kort' }, { ...PAK(22), ref: 'STORE-BOGSTAVER' },
    { ...PAK(22), sku: '../products' }, { ...PAK(22), pid: '' }, [PAK(22)], '{ups'];
  for (const k of forkerte) {
    const svar = await pak({ request: anmodning('/api/pak', k), env: ENV }, deps);
    assert.equal(svar.status, 400, JSON.stringify(k));
  }
  for (const opt of [{ origin: 'https://ond.example.com' }, { type: 'text/plain' }]) {
    assert.equal((await pak({ request: anmodning('/api/pak', PAK(22), opt), env: ENV }, deps)).status, 403);
  }
  assert.equal(rb.kald.length, 0);
  assert.deepEqual((await lager(deps)).pakninger, []);
});

test('pak: uden Rackbeat-nøgle reserveres intet', async () => {
  const { rb, deps } = await opsaet();
  await medData(deps);
  const svar = await pak({ request: anmodning('/api/pak', PAK(22)), env: { ...ENV, RACKBEAT_API_KEY: '' } }, deps);
  assert.equal(svar.status, 503);
  assert.equal(rb.kald.length, 0);
  assert.deepEqual((await lager(deps)).pakninger, []);
});

test('data: en batch, der er pakket fra, kan slettes, og pakningerne fra den slettes med. Rackbeat røres ikke', async () => {
  const { rb, deps } = await opsaet();
  await medData(deps);
  await pak({ request: anmodning('/api/pak', PAK(50)), env: ENV }, deps);   // 40 fra #1 og 10 fra #2
  const kaldFoer = rb.kald.length;
  let d = await medData(deps, { batches: { slet: [1] } });
  assert.deepEqual(d.batches.map(b => b.no), [2, 3]);
  assert.deepEqual(d.pakninger.map(k => k.linjer.map(l => [l.batch, l.antal])), [[[2, 10]]], 'kun linjen fra #2 er tilbage');
  d = await medData(deps, { batches: { slet: [2] } });
  assert.deepEqual(d.pakninger, [], 'en pakning uden linjer slettes');
  assert.equal(rb.kald.length, kaldFoer, 'intet sendt til Rackbeat');
  assert.equal(rb.beholdning.HAT003, 74, 'lageret i Rackbeat er urørt');
});

test('data: en batch med en pakning, der venter på Rackbeat, slettes ikke', async () => {
  const { deps } = await opsaet({ fejlFra: 5 });   // Bogføringen fejler, og Rackbeat svarer ikke bagefter
  await medData(deps);
  const svar = await pak({ request: anmodning('/api/pak', PAK(10)), env: ENV }, deps);
  assert.equal((await krop(svar)).pakning, 'venter');
  const d = await medData(deps, { batches: { slet: [1, 3] } });
  assert.deepEqual(d.batches.map(b => b.no), [1, 2]);
  assert.equal(d.pakninger[0].status, 'reserveret');
});

test('ruter: /api/data har GET og POST, /api/pak kun POST', () => {
  assert.deepEqual(Object.keys(dataRute).sort(), ['GET', 'POST']);
  assert.deepEqual(Object.keys(pakRute), ['POST']);
});

// ---------- historik ----------

const CHROME = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36', 'X-Kalender': 'abcd1234' };
const IPHONE = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' };
const PRODUKT = { id: 'havtorn-saebe', name: 'Havtorn sæbe', sku: 'HAT003', type: 'Sæbebarer', min: 50, batch: 60, cure: 22, steps: [] };
async function gem(deps, aendringer, ekstra = CHROME) {
  const svar = await gemData({ request: anmodning('/api/data', aendringer, { ekstra }), env: ENV }, deps);
  assert.equal(svar.status, 200, await svar.clone().text());
}
async function historik(deps, q = '') {
  const svar = await hentHistorik({ request: anmodning('/api/historik' + q, null, { metode: 'GET' }), env: ENV }, deps);
  assert.equal(svar.status, 200, await svar.clone().text());
  return (await krop(svar)).data;
}
const linjer = h => h.poster.map(p => `${p.kategori} | ${p.handling} | ${p.emne}`).reverse();

test('historik: hver ændring fra kalenderen skrives med hvad, detaljer, tidspunkt og enhed', async () => {
  const { deps } = await opsaet();
  await gem(deps, { produkter: { gem: [PRODUKT] }, personer: { gem: ['Anna'] } });
  const plan = B(7, '', '2026-11-20', 60, { status: 'planlagt' });
  await gem(deps, { batches: { gem: [plan] } });
  await gem(deps, { batches: { gem: [{ ...plan, label: 'K201106', status: 'aktiv', made: '2026-11-16', madeBy: 'Mette' }] } });
  const lavet = { ...plan, label: 'K201106', status: 'aktiv', made: '2026-11-16', madeBy: 'Mette' };
  await gem(deps, { batches: { gem: [{ ...lavet, steps: { demold: { on: '2026-11-17', by: 'Mette' } } }] } });
  await gem(deps, { batches: { gem: [{ ...lavet, qty: 58, cure: 24, steps: { demold: { on: '2026-11-17', by: 'Mette' } } }] } });
  await gem(deps, { batches: { gem: [{ ...lavet, qty: 58, cure: 24, status: 'kasseret', discardReason: { kategori: 'Andet', tekst: 'Formen revnede' } }] } });
  await gem(deps, { batches: { gem: [lavet] } });
  await gem(deps, { reservationer: { gem: [{ id: 'r1-0', group: 'r1', kind: 'event', who: 'Julemarked', pid: 'havtorn-saebe', qty: 30, date: '2026-12-05' }] } });
  await gem(deps, { reservationer: { slet: ['r1-0'] }, produkter: { gem: [{ ...PRODUKT, min: 60 }] } }, IPHONE);
  await gem(deps, { batches: { slet: [7] } });

  const h = await historik(deps);
  assert.deepEqual(linjer(h), [
    'produkt | Produkt oprettet | Havtorn sæbe (HAT003)',
    'person | Person tilføjet | Anna',
    'batch | Batch planlagt | uden nr. · Havtorn sæbe',
    'batch | Batch registreret som lavet | #K201106 · Havtorn sæbe',
    'batch | Taget ud af forme | #K201106 · Havtorn sæbe',
    'batch | Batch ændret | #K201106 · Havtorn sæbe',
    'batch | Batch markeret som fejlet, Udtagning af forme fortrudt | #K201106 · Havtorn sæbe',
    'batch | Batch gendannet | #K201106 · Havtorn sæbe',
    'bestilling | Event oprettet | Julemarked',
    'bestilling | Event slettet | Julemarked',
    'produkt | Produkt ændret | Havtorn sæbe (HAT003)',
    'batch | Batch slettet | #K201106 · Havtorn sæbe',
  ]);
  const p = Object.fromEntries(h.poster.map(x => [x.handling, x]));
  assert.equal(p['Batch planlagt'].tekst, '60 stk. Havtorn sæbe, start 20. nov. 2026, 22 dage før pakning (pakkes 12. dec. 2026), oprettet af Anna');
  assert.match(p['Batch registreret som lavet'].tekst, /Batchnr\.: – → K201106\. Dato: 20\. nov\. 2026 → 16\. nov\. 2026\. Lavet af: – → Mette/);
  assert.equal(p['Taget ud af forme'].tekst, 'Taget ud af forme 17. nov. 2026 af Mette');
  assert.equal(p['Batch ændret'].tekst, 'Antal: 60 → 58. Dage før pakning: 22 → 24');
  assert.deepEqual(p['Batch ændret'].detaljer, { foer: { qty: 60, cure: 22 }, efter: { qty: 58, cure: 24 } });
  assert.equal(p['Batch markeret som fejlet, Udtagning af forme fortrudt'].tekst, 'Årsag: Andet: Formen revnede');
  assert.equal(p['Event oprettet'].tekst, '30 stk. Havtorn sæbe til 5. dec. 2026');
  assert.equal(p['Produkt ændret'].tekst, 'Minimum: 50 → 60');
  assert.equal(p['Produkt ændret'].enhed, 'Safari på iPhone');
  assert.equal(p['Batch slettet'].enhed, 'Chrome på Windows · abcd1234');
  assert.ok(h.poster.every(x => !isNaN(Date.parse(x.tid)) && Number.isInteger(x.id)));
  assert.equal(h.flere, false);
});

test('historik: det samme sendt igen giver ingen nye linjer', async () => {
  const { deps } = await opsaet();
  await gem(deps, { produkter: { gem: [PRODUKT] }, ...TRE_BATCHES });
  const foer = (await historik(deps)).poster.length;
  await gem(deps, { produkter: { gem: [PRODUKT] }, ...TRE_BATCHES });
  await gem(deps, { personer: { gem: [] } });
  assert.equal((await historik(deps)).poster.length, foer);
});

test('historik: pakning med Rackbeat-regulering og beholdning før og efter', async () => {
  const { deps } = await opsaet();
  await gem(deps, { produkter: { gem: [PRODUKT] }, ...TRE_BATCHES });
  await pak({ request: anmodning('/api/pak', { ...PAK(50, 2), navn: 'Havtorn sæbe' }, { ekstra: CHROME }), env: ENV }, deps);
  const [x] = (await historik(deps, '?kategori=pakning')).poster;
  assert.equal(x.handling, 'Pakket og lagt i Rackbeat');
  assert.equal(x.emne, 'Havtorn sæbe (HAT003)');
  assert.equal(x.tekst, '50 stk. taget ud af produktionslageret, heraf 2 kasseret. Fra batch #1: 40 stk. (2 kasseret), #2: 10 stk. Lagt på Hovedlager i Rackbeat: 48 stk. (regulering 5001, beholdning 24 → 72).');
  assert.equal(x.enhed, 'Chrome på Windows · abcd1234');
  assert.equal(x.detaljer.ref, 'pak-aaaaaaaa');
  // Sletter man batchen bagefter, står det i historikken, at der var pakket fra den
  await gem(deps, { batches: { slet: [1] } });
  const [slet] = (await historik(deps, '?kategori=batch&antal=1')).poster;
  assert.equal(slet.handling, 'Batch slettet');
  assert.match(slet.tekst, /Der var pakket 40 stk\. fra den \(1 pakning\)\. Pakningerne er fjernet i kalenderen, men det, der er lagt på lager i Rackbeat, er ikke ændret\./);
});

test('historik: fejl ved pakning skrives, også når der ikke er nok klar', async () => {
  const { deps } = await opsaet({ fejl: { opret: 422 } });
  await gem(deps, { produkter: { gem: [PRODUKT] }, ...TRE_BATCHES });
  await pak({ request: anmodning('/api/pak', PAK(22)), env: ENV }, deps);
  await pak({ request: anmodning('/api/pak', PAK(500, 0, 'pak-bbbbbbbb')), env: ENV }, deps);
  const h = (await historik(deps, '?kategori=fejl')).poster;
  assert.deepEqual(h.map(x => x.tekst).reverse(), [
    '22 stk.: Rackbeat afviste reguleringen. Intet er lagt på lager i Rackbeat, og stk. er tilbage på produktionslageret.',
    '500 stk.: Der var kun 65 stk. klar til pakning. Intet er taget ud af produktionslageret.',
  ]);
  assert.ok(h.every(x => x.handling === 'Pakning fejlede'));
  assert.equal(h[1].detaljer.udfald, 'annulleret');
});

test('historik: en batch, der ikke slettes (pakning venter), og et produkt i brug står ikke som slettet', async () => {
  const { deps } = await opsaet({ fejlFra: 5 });
  await gem(deps, { produkter: { gem: [PRODUKT] }, ...TRE_BATCHES });
  await pak({ request: anmodning('/api/pak', PAK(10)), env: ENV }, deps);
  await gem(deps, { batches: { slet: [1] }, produkter: { slet: ['havtorn-saebe'] } });
  const h = (await historik(deps)).poster;
  assert.ok(!h.some(x => /slettet/.test(x.handling)), h.map(x => x.handling).join(', '));
  assert.equal(h[0].kategori, 'fejl');
  assert.equal(h[0].detaljer.udfald, 'venter');
});

test('historik: nyeste først, ældre sider, kategori og søgning', async () => {
  const { deps } = await opsaet();
  await gem(deps, { produkter: { gem: [PRODUKT] } });
  for (let i = 1; i <= 7; i++) await gem(deps, { batches: { gem: [B(i, 'K' + i, '2026-11-01', 10 + i)] } });
  let h = await historik(deps, '?antal=3');
  assert.deepEqual(h.poster.map(x => x.emne), ['#K7 · Havtorn sæbe', '#K6 · Havtorn sæbe', '#K5 · Havtorn sæbe']);
  assert.equal(h.flere, true);
  h = await historik(deps, `?antal=10&foer=${h.poster[2].id}`);
  assert.equal(h.poster.length, 5);
  assert.equal(h.flere, false);
  assert.equal((await historik(deps, '?kategori=produkt')).poster.length, 1);
  assert.deepEqual((await historik(deps, '?soeg=k3')).poster.map(x => x.emne), ['#K3 · Havtorn sæbe']);
  assert.equal((await historik(deps, '?soeg=13 stk')).poster.length, 1, 'søger også i detaljerne');
  assert.equal((await historik(deps, '?kategori=noget')).poster.length, 8, 'ukendt kategori ignoreres');
});

test('ruter: /api/historik har kun GET', () => {
  assert.deepEqual(Object.keys(historikRute), ['GET']);
});
