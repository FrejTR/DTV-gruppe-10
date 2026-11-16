// Test af /api/data og /api/pak mod en rigtig Postgres (PGlite) med migrationerne og en falsk Rackbeat.
// Ingen rigtige nøgler. Kørsel: node --test "tests/*.test.mjs"
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as dataRute from '../api/data.mjs';
import * as pakRute from '../api/pak.mjs';
import { gemData, hentData, pak } from '../functions/_lib/faelles.js';
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

function anmodning(sti, k, { origin = ORIGIN, type = 'application/json', metode = 'POST' } = {}) {
  const hoveder = {};
  if (origin) hoveder.Origin = origin;
  if (type) hoveder['Content-Type'] = type;
  return new Request(ORIGIN + sti, { method: metode, headers: hoveder, ...(metode === 'POST' ? { body: typeof k === 'string' ? k : JSON.stringify(k) } : {}) });
}

/** Falsk Rackbeat til skrivning, med hukommelse, så et nyt forsøg kan se, hvad der skete første gang.
 *  fejl: {find, opret, hent, bogfoer} = HTTP-status eller 'net'. tabtSvar: bogføringen sker, men svaret går tabt.
 *  saetTil: Rackbeat gemmer reguleringer som "sæt til" i stedet for "læg til". */
function falskRackbeat({ fejl = {}, tabtSvar = false, saetTil = false } = {}) {
  const kald = [], reguleringer = [];
  let id = 5000;
  const svar = (krop, status) => new Response(JSON.stringify(krop), { status });
  const hent = async (url, init = {}) => {
    const metode = init.method || 'GET', sti = new URL(url).pathname;
    const k = init.body ? JSON.parse(init.body) : null;
    const en = /\/inventory-adjustments\/(\d+)$/.exec(sti);
    const hvad = metode === 'DELETE' ? 'slet' : metode === 'GET' ? (en ? 'hent' : 'find') : sti.endsWith('/book') ? 'bogfoer' : 'opret';
    kald.push({ hvad, sti, krop: k, auth: init.headers && init.headers.Authorization });
    const f = fejl[hvad];
    if (f === 'net') throw new TypeError('fetch failed');
    if (f) return svar({ errors: { message: 'nej ' + RB_NOEGLE } }, f);
    if (hvad === 'find') return svar({ inventory_regulations: [...reguleringer].reverse() }, 206);
    if (hvad === 'hent') return svar({ inventory_regulation: reguleringer.find(x => x.id === Number(en[1])) }, 200);
    if (hvad === 'slet') { reguleringer.splice(reguleringer.findIndex(x => x.id === Number(en[1])), 1); return new Response('', { status: 200 }); }
    if (hvad === 'opret') {
      const r = { id: ++id, is_booked: false, regulate_difference: saetTil || k.regulate_diff !== false, description: k.description, krop: k };
      reguleringer.push(r);
      return svar({ inventory_regulation: { id: r.id, is_booked: false } }, 201);
    }
    const r = reguleringer.find(x => sti.endsWith(`/${x.id}/book`));
    r.is_booked = true;
    if (tabtSvar) throw new TypeError('fetch failed');
    return new Response('', { status: 200 });
  };
  return { hent, kald, reguleringer };
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
  assert.deepEqual(rb.kald.map(k => k.hvad), ['find', 'opret', 'hent', 'bogfoer'], 'tjekker "læg til" i Rackbeat før bogføring');
  assert.deepEqual(rb.kald[1].krop, { regulated_at: '2026-11-16', reason: 'Pakket fra batch #1', description: 'Produktionskalender, ref. pak-aaaaaaaa',
    adjustment_type: 'quantity', item_id: 'HAT003', location: 1001, quantity: '20', regulation_type: 1004, regulate_diff: false });
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
  assert.equal(rb.kald[1].krop.reason, 'Pakket fra batch #1, #2');
  svar = await pak({ request: anmodning('/api/pak', PAK(16, 0, 'pak-bbbbbbbb')), env: ENV }, deps);
  assert.equal(svar.status, 409, 'batch #3 hærder stadig, så der er kun 15 klar');
  const b = await krop(svar);
  assert.equal(b.kode, 'ikke_nok_klar'); assert.equal(b.klar, 15);
  assert.equal(rb.kald.length, 4, 'intet sendt til Rackbeat');
});

test('pak: samme ref igen tager ikke stk. ud to gange og sender intet til Rackbeat', async () => {
  const { rb, deps } = await opsaet();
  await medData(deps);
  await pak({ request: anmodning('/api/pak', PAK(22, 2)), env: ENV }, deps);
  const svar = await pak({ request: anmodning('/api/pak', PAK(22, 2)), env: ENV }, deps);
  assert.equal(svar.status, 200);
  assert.equal((await krop(svar)).data.allerede, true);
  assert.equal(rb.kald.length, 4);
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
  for (const fejl of [{ opret: 422 }, { opret: 403 }, { find: 401 }, { find: 'net' }]) {
    const { rb, deps } = await opsaet({ fejl });
    await medData(deps);
    const svar = await pak({ request: anmodning('/api/pak', PAK(22)), env: ENV }, deps);
    assert.equal(svar.status, 502, JSON.stringify(fejl));
    assert.equal((await krop(svar)).pakning, 'annulleret', JSON.stringify(fejl));
    assert.deepEqual((await lager(deps)).pakninger, []);
    assert.ok(rb.kald.filter(k => k.hvad === 'opret').length <= 1, 'et POST sendes aldrig to gange');
    await ingenHemmeligheder(svar);
  }
});

test('pak: ville Rackbeat sætte lageret i stedet for at lægge til, bogføres intet, og stk. gives tilbage', async () => {
  const { rb, deps } = await opsaet({ saetTil: true });
  await medData(deps);
  const svar = await pak({ request: anmodning('/api/pak', PAK(22)), env: ENV }, deps);
  assert.equal(svar.status, 502);
  const b = await krop(svar);
  assert.equal(b.kode, 'ville_saette_lager'); assert.equal(b.pakning, 'annulleret');
  assert.ok(!rb.kald.some(k => k.hvad === 'bogfoer'), 'ingen bogføring');
  assert.equal(rb.reguleringer.length, 0, 'kladden er slettet, så ingen bogfører den i hånden');
  assert.deepEqual((await lager(deps)).pakninger, []);
});

test('pak: fejlet bogføring venter, og samme ref bogfører kladden uden at oprette en ny', async () => {
  const { rb, deps } = await opsaet({ fejl: { bogfoer: 500 } });
  await medData(deps);
  let svar = await pak({ request: anmodning('/api/pak', PAK(22)), env: ENV }, deps);
  assert.equal(svar.status, 502);
  assert.equal((await krop(svar)).pakning, 'venter');
  let d = await lager(deps);
  assert.equal(d.pakninger[0].status, 'reserveret', 'stk. er stadig taget ud, så de ikke kan pakkes to gange');
  // Rackbeat virker igen
  const igen = { ...deps, rackbeat: { fetch: falskRackbeatMed(rb) } };
  svar = await pak({ request: anmodning('/api/pak', PAK(22)), env: ENV }, igen);
  assert.equal(svar.status, 201);
  assert.equal(rb.reguleringer.length, 1, 'kun én regulering i Rackbeat');
  assert.equal(rb.reguleringer[0].is_booked, true);
  d = await lager(deps);
  assert.equal(d.pakninger[0].status, 'bogfoert');
});

/** Samme reguleringer som rb, men uden fejl */
function falskRackbeatMed(rb) {
  const ny = falskRackbeat();
  ny.reguleringer.push(...rb.reguleringer);
  return ny.hent;
}

test('pak: bogført, men svaret gik tabt, tæller som pakket', async () => {
  const { rb, deps } = await opsaet({ tabtSvar: true });
  await medData(deps);
  const svar = await pak({ request: anmodning('/api/pak', PAK(22)), env: ENV }, deps);
  assert.equal(svar.status, 201, await svar.clone().text());
  assert.equal((await krop(svar)).data.pakning.status, 'bogfoert');
  assert.equal(rb.reguleringer.length, 1);
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

test('data: en batch, der er pakket fra, kan ikke slettes', async () => {
  const { deps } = await opsaet();
  await medData(deps);
  await pak({ request: anmodning('/api/pak', PAK(10)), env: ENV }, deps);
  const d = await medData(deps, { batches: { slet: [1, 3] } });
  assert.deepEqual(d.batches.map(b => b.no), [1, 2]);
});

test('ruter: /api/data har GET og POST, /api/pak kun POST', () => {
  assert.deepEqual(Object.keys(dataRute).sort(), ['GET', 'POST']);
  assert.deepEqual(Object.keys(pakRute), ['POST']);
});
