// Test af serverfunktionerne (Vercel) mod en falsk Rackbeat. Ingen rigtig nøgle. Kørsel: node --test "tests/*.test.mjs"
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as statusRute from '../api/status.mjs';
import * as salgstempoRute from '../api/salgstempo.mjs';
import * as reguleringRute from '../api/lagerregulering.mjs';
import { status, salgstempo, lagerregulering, STATUS_TTL_MS, SALGSTEMPO_TTL_MS } from '../functions/_lib/endpoints.js';
import { _nulstil as nulstilCache } from '../functions/_lib/cache.js';
import { erLokalUdvikling, lokaleDeps } from '../functions/_lib/lokal.js';

const NOEGLE = 'hemmelig-test-noegle-123';
const LAGER_NOEGLE = 'hemmelig-lager-noegle-456';
const SKRIV_NOEGLE = 'hemmelig-skrive-noegle-789';
const ENV = { RACKBEAT_API_KEY: NOEGLE };
const URL_PROD = 'https://kalender.example.com/api/status';

// ---------- falsk Rackbeat ----------
function linje(sku, antal, dato, nr = 1, annulleret = false) {
  return { id: nr, text: 'Sæbe', item: { number: sku }, quantities: { ordered: antal, shipped: 0 }, prices: { total: 99 },
    order: { number: nr, order_date: `${dato}T09:30:00+01:00`, status: { is_cancelled: annulleret },
      customer: { number: 77, name: 'Hemmelig Kunde ApS' } } };
}
const side = (felt, poster, nr, sider) => new Response(JSON.stringify({ [felt]: poster, total: poster.length, pages: sider, limit: 100, page: nr }), { status: 206 });

function falskRackbeat(opsaet = {}) {
  const kald = [];
  const hent = async (url, init = {}) => {
    const u = new URL(url);
    kald.push({ url, metode: init.method || 'GET', auth: init.headers && init.headers.Authorization });
    if (opsaet.netvaerk) throw new TypeError('fetch failed');
    const hvad = u.pathname.endsWith('/products') ? 'products' : 'order_lines';
    const fejl = opsaet[hvad + 'Status'];
    if (fejl) return new Response(JSON.stringify({ errors: { message: 'nej ' + NOEGLE } }), { status: fejl });
    const sider = opsaet[hvad] || (hvad === 'products'
      ? [[{ number: 'HAT003', stock_quantity: 62 }, { number: 'TAN001', stock_quantity: -3 }]]
      : [[linje('HAT003', 2, '2026-11-02', 1), linje('HAT003', 3, '2026-11-02', 2), linje('TAN001', 1, '2026-10-30', 3),
          linje('TAN001', 5, '2026-10-30', 4, true), linje('', 1, '2026-10-30', 5), linje('TAN001', -2, '2026-10-30', 6)]]);
    const nr = Number(u.searchParams.get('page'));
    return side(hvad, sider[nr - 1] || [], nr, sider.length);
  };
  return { hent, kald };
}

// 3. november 2026 kl. 12 dansk tid
const NU = Date.parse('2026-11-03T11:00:00Z');
let ur;
const ctx = (env = ENV, url = URL_PROD) => {
  const ventende = [];
  return { request: new Request(url), env, waitUntil: p => ventende.push(p), ventende };
};
const deps = (rb, ekstra = {}) => ({ fetch: rb.hent, vent: async () => {}, nu: () => ur, ...ekstra });

let logs;
const originalError = console.error;
beforeEach(() => {
  nulstilCache(); ur = NU; logs = [];
  console.error = (...a) => logs.push(a.join(' '));
});
afterEach(() => { console.error = originalError; });

const krop = async svar => JSON.parse(await svar.clone().text());
async function ingenHemmeligheder(svar) {
  const tekst = await svar.clone().text();
  for (const s of [NOEGLE, LAGER_NOEGLE, SKRIV_NOEGLE, 'Hemmelig Kunde', 'Bearer']) {
    assert.ok(!tekst.includes(s), `svaret indeholder ${s}`);
    assert.ok(!logs.join('\n').includes(s), `loggen indeholder ${s}`);
  }
}

// ---------- /api/status ----------
test('status: format, lager og salg pr. sku og dag uden persondata', async () => {
  const rb = falskRackbeat();
  const svar = await status(ctx(), deps(rb));
  assert.equal(svar.status, 200);
  const b = await krop(svar);
  assert.deepEqual(Object.keys(b).sort(), ['data', 'forældet', 'hentet', 'kilde']);
  assert.equal(b.kilde, 'rackbeat'); assert.equal(b.forældet, false);
  assert.equal(b.hentet, new Date(NU).toISOString());
  assert.deepEqual(b.data.lager, { HAT003: 62, TAN001: -3 });
  assert.equal(b.data.lagerStatus, 'ok');
  // Annulleret, uden varenummer og negativt antal er sorteret fra
  assert.deepEqual(b.data.salg, { HAT003: { '2026-11-02': 5 }, TAN001: { '2026-10-30': 1 } });
  assert.equal(b.data.salgFra, '2026-10-28'); assert.equal(b.data.salgTil, '2026-11-03');
  await ingenHemmeligheder(svar);
});

test('status: kun GET mod faste Rackbeat-adresser med Bearer-nøgle', async () => {
  const rb = falskRackbeat();
  await status(ctx(), deps(rb));
  assert.ok(rb.kald.length > 0);
  for (const k of rb.kald) {
    assert.equal(k.metode, 'GET');
    assert.equal(k.auth, `Bearer ${NOEGLE}`);
    assert.match(k.url, /^https:\/\/app\.rackbeat\.com\/api\/(orders\/lines|products)\?/);
  }
  const ordre = new URL(rb.kald.find(k => k.url.includes('/orders/lines')).url);
  assert.equal(ordre.searchParams.get('order_date_from'), '2026-10-28 00:00:00');
  assert.equal(ordre.searchParams.get('order_date_to'), '2026-11-03 23:59:59');
  assert.equal(new URL(rb.kald.find(k => k.url.includes('/products')).url).searchParams.get('fields'), 'number,stock_quantity');
});

test('status: klienten kan ikke styre Rackbeat-sti eller adresse', async () => {
  const rb = falskRackbeat();
  await status(ctx(ENV, URL_PROD + '?sti=/customers&url=https://ondt.example&page=9'), deps(rb));
  assert.ok(rb.kald.every(k => k.url.startsWith('https://app.rackbeat.com/api/') && !k.url.includes('customers') && !k.url.includes('ondt')));
});

test('status: separat lagernøgle bruges kun til lager', async () => {
  const rb = falskRackbeat();
  await status(ctx({ ...ENV, RACKBEAT_LAGER_KEY: LAGER_NOEGLE }), deps(rb));
  assert.equal(rb.kald.find(k => k.url.includes('/products')).auth, `Bearer ${LAGER_NOEGLE}`);
  assert.equal(rb.kald.find(k => k.url.includes('/orders')).auth, `Bearer ${NOEGLE}`);
});

test('status: manglende nøgle giver 503', async () => {
  const svar = await status(ctx({ ...ENV, RACKBEAT_API_KEY: '' }), deps(falskRackbeat()));
  assert.equal(svar.status, 503);
  assert.equal((await krop(svar)).kode, 'ikke_sat_op');
});

test('status: cache. Andet kald inden for 20 sekunder rammer ikke Rackbeat', async () => {
  const rb = falskRackbeat();
  await status(ctx(), deps(rb));
  const foer = rb.kald.length;
  ur = NU + STATUS_TTL_MS - 1;
  const b = await krop(await status(ctx(), deps(rb)));
  assert.equal(rb.kald.length, foer);
  assert.equal(b.hentet, new Date(NU).toISOString());
  ur = NU + STATUS_TTL_MS;
  await status(ctx(), deps(rb));
  assert.ok(rb.kald.length > foer);
});

test('status: samtidige kald giver kun én hentning', async () => {
  const rb = falskRackbeat();
  await Promise.all([1, 2, 3, 4, 5].map(() => status(ctx(), deps(rb))));
  assert.equal(rb.kald.length, 2);   // én side ordrelinjer og én side produkter
});

for (const kode of [401, 403, 404, 429, 500, 502, 503]) {
  test(`status: Rackbeat ${kode} giver gemt version som forældet`, async () => {
    await status(ctx(), deps(falskRackbeat()));
    ur = NU + 60 * 1000;
    const svar = await status(ctx(), deps(falskRackbeat({ order_linesStatus: kode })));
    assert.equal(svar.status, 200);
    const b = await krop(svar);
    assert.equal(b.forældet, true);
    assert.equal(b.hentet, new Date(NU).toISOString());
    assert.deepEqual(b.data.lager, { HAT003: 62, TAN001: -3 });
    await ingenHemmeligheder(svar);
  });

  test(`status: Rackbeat ${kode} uden gemt version giver kort fejl`, async () => {
    const svar = await status(ctx(), deps(falskRackbeat({ order_linesStatus: kode })));
    assert.equal(svar.status, 502);
    const b = await krop(svar);
    assert.equal(b.data, null); assert.equal(b.forældet, true);
    assert.ok(b.fejl.length < 40);
    await ingenHemmeligheder(svar);
  });
}

test('status: netværksfejl giver gemt version', async () => {
  await status(ctx(), deps(falskRackbeat()));
  ur = NU + 60 * 1000;
  const b = await krop(await status(ctx(), deps(falskRackbeat({ netvaerk: true }))));
  assert.equal(b.forældet, true);
});

test('status: lager 403 (nøglen har kun ordreadgang) giver resten af data', async () => {
  const svar = await status(ctx(), deps(falskRackbeat({ productsStatus: 403 })));
  assert.equal(svar.status, 200);
  const b = await krop(svar);
  assert.equal(b.forældet, false);
  assert.equal(b.data.lager, null);
  assert.equal(b.data.lagerStatus, 'mangler_adgang');
  assert.deepEqual(Object.keys(b.data.salg), ['HAT003', 'TAN001']);
});

test('status: lager 500 behandles som fejl, ikke som manglende adgang', async () => {
  const svar = await status(ctx(), deps(falskRackbeat({ productsStatus: 500 })));
  assert.equal(svar.status, 502);
});

test('status: paginering henter alle sider', async () => {
  const rb = falskRackbeat({ order_lines: [[linje('A', 1, '2026-11-01', 1)], [linje('A', 2, '2026-11-01', 2)], [linje('B', 4, '2026-11-02', 3)]] });
  const b = await krop(await status(ctx(), deps(rb)));
  assert.deepEqual(b.data.salg, { A: { '2026-11-01': 3 }, B: { '2026-11-02': 4 } });
  assert.deepEqual(rb.kald.filter(k => k.url.includes('/orders')).map(k => new URL(k.url).searchParams.get('page')), ['1', '2', '3']);
});

test('status: tom side giver tomme data uden fejl', async () => {
  const rb = falskRackbeat({ order_lines: [[]], products: [[]] });
  const b = await krop(await status(ctx(), deps(rb)));
  assert.deepEqual(b.data.salg, {});
  assert.deepEqual(b.data.lager, {});
});

test('status: uventet format afvises', async () => {
  const rb = falskRackbeat({ products: [[{ sku: 'HAT003', stock_quantity: 1 }]] });
  const svar = await status(ctx(), deps(rb));
  assert.equal(svar.status, 502);
  assert.equal((await krop(svar)).kode, 'uventet_svar');
});

// ---------- /api/salgstempo ----------
function historik() {
  const linjer = [];
  for (let i = 0; i < 60; i++) {
    const d = new Date(Date.UTC(2025, 9, 1) + i * 7 * 86400000).toISOString().slice(0, 10);
    linjer.push(linje('HAT003', 10, d, 1000 + i), linje('LAN002', i % 4 === 0 ? 1 : 0, d, 2000 + i));
  }
  return [linjer.slice(0, 50), linjer.slice(50, 100), linjer.slice(100)];
}

test('salgstempo: beregner med paginering og samme felter som JSON-filen', async () => {
  const rb = falskRackbeat({ order_lines: historik() });
  const svar = await salgstempo(ctx(), deps(rb));
  const b = await krop(svar);
  assert.equal(b.forældet, false);
  assert.equal(b.data.HAT003.rate, 10);
  assert.equal(b.data.HAT003.beregnet, '2026-11-03');
  assert.equal(b.data.HAT003.vindue_uger, 52);
  assert.ok(b.data.LAN002.flag.includes('lavt_salg'));
  assert.equal(rb.kald.length, 3);
  const u = new URL(rb.kald[0].url);
  // 52 hele uger før mandag 2. nov. 2026 er 3. nov. 2025 til 1. nov. 2026, plus 26 ugers historik
  assert.equal(u.searchParams.get('order_date_from'), '2025-05-05 00:00:00');
  assert.equal(u.searchParams.get('order_date_to'), '2026-11-01 23:59:59');
  await ingenHemmeligheder(svar);
});

test('salgstempo: cache i 1 time, derefter gammel version straks og ny i baggrunden', async () => {
  const rb = falskRackbeat({ order_lines: historik() });
  await salgstempo(ctx(), deps(rb));
  const foer = rb.kald.length;
  ur = NU + SALGSTEMPO_TTL_MS - 1;
  await salgstempo(ctx(), deps(rb));
  assert.equal(rb.kald.length, foer, 'inden for en time');

  ur = NU + SALGSTEMPO_TTL_MS + 5;
  const c = ctx();
  // Rackbeat svarer først, når svaret til klienten er sendt
  let frigiv;
  const port = new Promise(r => { frigiv = r; });
  const langsom = { ...deps(rb), fetch: async (...a) => { await port; return rb.hent(...a); } };
  const b = await krop(await salgstempo(c, langsom));
  assert.equal(b.hentet, new Date(NU).toISOString(), 'gammel version sendes uden at vente');
  assert.equal(b.forældet, false);
  assert.equal(c.ventende.length, 1, 'genberegning i baggrunden');
  assert.equal(rb.kald.length, foer, 'Rackbeat har endnu ikke svaret');
  frigiv();
  await c.ventende[0];
  const ny = await krop(await salgstempo(ctx(), deps(rb)));
  assert.equal(ny.hentet, new Date(NU + SALGSTEMPO_TTL_MS + 5).toISOString());
});

test('salgstempo: fejlet genberegning markeres forældet efter 2 timer', async () => {
  await salgstempo(ctx(), deps(falskRackbeat({ order_lines: historik() })));
  ur = NU + 2 * SALGSTEMPO_TTL_MS + 1;
  const c = ctx();
  const b = await krop(await salgstempo(c, deps(falskRackbeat({ order_linesStatus: 500 }))));
  assert.equal(b.forældet, true);
  await Promise.all(c.ventende);
  assert.ok(logs.some(l => l.includes('rackbeat_fejl')));
});

test('salgstempo: for mange sider giver fejl frem for halv historik', async () => {
  const sider = Array.from({ length: 41 }, (_, i) => [linje('A', 1, '2026-01-05', i)]);
  const svar = await salgstempo(ctx({ ...ENV, SALGSTEMPO_MAX_SIDER: '40' }), deps(falskRackbeat({ order_lines: sider })));
  assert.equal(svar.status, 502);
  assert.equal((await krop(svar)).kode, 'for_mange_sider');
  nulstilCache();
  const hoejere = await salgstempo(ctx({ ...ENV, SALGSTEMPO_MAX_SIDER: '60' }), deps(falskRackbeat({ order_lines: sider })));
  assert.equal(hoejere.status, 200, 'grænsen kan ændres');
  nulstilCache();
  const standard = await salgstempo(ctx(), deps(falskRackbeat({ order_lines: sider })));
  assert.equal(standard.status, 200, 'standardgrænsen er 200 sider');
});

test('salgstempo: manglende nøgle giver 503 og 429 uden gemt version giver 502', async () => {
  assert.equal((await salgstempo(ctx({ ...ENV, RACKBEAT_API_KEY: undefined }), deps(falskRackbeat()))).status, 503);
  const svar = await salgstempo(ctx(), deps(falskRackbeat({ order_linesStatus: 429 })));
  assert.equal(svar.status, 502);
  await ingenHemmeligheder(svar);
});

// ---------- Vercel-ruter ----------
test('ruter: kun GET er eksporteret, så Vercel afviser alt andet med 405', () => {
  for (const rute of [statusRute, salgstempoRute]) {
    assert.equal(typeof rute.GET, 'function');
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'default']) assert.equal(rute[m], undefined, m);
  }
});

test('ruter: /api/lagerregulering eksporterer kun POST', () => {
  assert.equal(typeof reguleringRute.POST, 'function');
  for (const m of ['GET', 'PUT', 'PATCH', 'DELETE', 'default']) assert.equal(reguleringRute[m], undefined, m);
});

async function medMiljoe(vaerdier, opgave) {
  const gammel = {};
  for (const [k, v] of Object.entries(vaerdier)) { gammel[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await opgave(); }
  finally { for (const [k, v] of Object.entries(gammel)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
async function medFalskFetch(opgave) {
  const kald = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => { kald.push({ url: String(url), metode: init.method, auth: init.headers && init.headers.Authorization }); return side('order_lines', [], 1, 0); };
  try { await opgave(); } finally { globalThis.fetch = original; }
  return kald;
}

test('ruter: GET /api/status henter fra Rackbeat med nøglen fra miljøet', async () => {
  const kald = await medFalskFetch(() => medMiljoe({ VERCEL: '1', RACKBEAT_API_KEY: NOEGLE, RACKBEAT_LAGER_KEY: undefined, RACKBEAT_BASE_URL: undefined },
    () => statusRute.GET(new Request('https://kalender.example.com/api/status'))));
  assert.ok(kald.length > 0);
  assert.ok(kald.every(k => k.metode === 'GET' && k.auth === `Bearer ${NOEGLE}` && k.url.startsWith('https://app.rackbeat.com/api/')));
});

test('ruter: GET /api/salgstempo bruger samme kilde', async () => {
  const kald = await medFalskFetch(() => medMiljoe({ VERCEL: '1', RACKBEAT_API_KEY: NOEGLE, RACKBEAT_BASE_URL: undefined },
    () => salgstempoRute.GET(new Request('https://kalender.example.com/api/salgstempo'))));
  assert.ok(kald.length > 0 && kald.every(k => k.url.startsWith('https://app.rackbeat.com/api/orders/lines?')));
});

test('ruter: manglende nøgle giver 503 uden kald til Rackbeat', async () => {
  let svar;
  const kald = await medFalskFetch(async () => {
    svar = await medMiljoe({ VERCEL: '1', RACKBEAT_API_KEY: undefined }, () => statusRute.GET(new Request('https://kalender.example.com/api/status')));
  });
  assert.equal(svar.status, 503);
  assert.equal(kald.length, 0);
});

test('lokal: RACKBEAT_BASE_URL virker kun uden for Vercel og kun fra localhost', async () => {
  const lokal = new Request('http://localhost:8788/api/status');
  const prod = new Request('https://kalender.example.com/api/status');
  assert.deepEqual(lokaleDeps(lokal, { RACKBEAT_BASE_URL: 'http://mock.local' }), { basisUrl: 'http://mock.local' });
  assert.deepEqual(lokaleDeps(new Request('http://127.0.0.1:8788/x'), { RACKBEAT_BASE_URL: 'http://mock.local' }), { basisUrl: 'http://mock.local' });
  assert.deepEqual(lokaleDeps(prod, { RACKBEAT_BASE_URL: 'http://mock.local' }), {}, 'ikke fra et rigtigt domæne');
  assert.deepEqual(lokaleDeps(lokal, { RACKBEAT_BASE_URL: 'http://mock.local', VERCEL: '1' }), {}, 'aldrig på Vercel');
  assert.deepEqual(lokaleDeps(lokal, {}), {}, 'ikke som standard');
  assert.equal(erLokalUdvikling(new Request('http://localhost.evil.example/'), {}), false);

  const kald = await medFalskFetch(() => medMiljoe({ VERCEL: '1', RACKBEAT_API_KEY: NOEGLE, RACKBEAT_BASE_URL: 'http://mock.local' },
    () => salgstempoRute.GET(lokal)));
  assert.ok(kald.every(k => k.url.startsWith('https://app.rackbeat.com/api/')), 'på Vercel ignoreres adressen: ' + kald.map(k => k.url));
});

// ---------- POST /api/lagerregulering ----------
const URL_REG = 'https://kalender.example.com/api/lagerregulering';
const REG_ENV = { RACKBEAT_API_KEY: NOEGLE, RACKBEAT_LAGER_KEY: LAGER_NOEGLE, RACKBEAT_SKRIV_KEY: SKRIV_NOEGLE };
const GYLDIG = { sku: 'HAT003', antal: 63, batch: 43, reference: 'b43-1a2b3c4d' };

function regAnmodning(krop = GYLDIG, { origin = 'https://kalender.example.com', type = 'application/json' } = {}) {
  const hoveder = {};
  if (origin) hoveder.Origin = origin;
  if (type) hoveder['Content-Type'] = type;
  return new Request(URL_REG, { method: 'POST', headers: hoveder, body: typeof krop === 'string' ? krop : JSON.stringify(krop) });
}

/** Falsk Rackbeat til skrivning. eksisterende: reguleringer, der allerede findes. postStatus: svar på POST. */
function falskSkriv({ eksisterende = [], postStatus = 201, netvaerk = false } = {}) {
  const kald = [];
  const hent = async (url, init = {}) => {
    kald.push({ url, metode: init.method || 'GET', auth: init.headers && init.headers.Authorization, krop: init.body ? JSON.parse(init.body) : null });
    if (netvaerk) throw new TypeError('fetch failed');
    if ((init.method || 'GET') === 'GET') return new Response(JSON.stringify({ inventory_regulations: eksisterende, total: eksisterende.length, pages: 1, limit: 100, page: 1 }), { status: 206 });
    if (postStatus !== 201) return new Response(JSON.stringify({ errors: { item_id: ['invalid ' + SKRIV_NOEGLE] } }), { status: postStatus });
    return new Response(JSON.stringify({ inventory_regulation: { id: 4711 } }), { status: 201 });
  };
  return { hent, kald };
}
const poster = kald => kald.filter(k => k.metode === 'POST');

test('lagerregulering: lægger antallet til på Hovedlager i kategorien Produktion med skrivenøglen', async () => {
  const rb = falskSkriv();
  const svar = await lagerregulering({ request: regAnmodning(), env: REG_ENV }, deps(rb));
  assert.equal(svar.status, 201);
  const b = await krop(svar);
  assert.deepEqual(b.data, { id: 4711, sku: 'HAT003', antal: 63, lokation: 1001, dato: '2026-11-03', allerede: false });
  assert.equal(poster(rb.kald).length, 1);
  const p = poster(rb.kald)[0];
  assert.equal(p.url, 'https://app.rackbeat.com/api/inventory-adjustments');
  assert.deepEqual(p.krop, { regulated_at: '2026-11-03', reason: 'Batch #43 godkendt', description: 'Produktionskalender, ref. b43-1a2b3c4d',
    adjustment_type: 'quantity', item_id: 'HAT003', location: 1001, quantity: '63', regulation_type: 1004, regulate_diff: false });
  // "Læg til", aldrig "sæt til", og aldrig bogføring
  assert.ok(!('book' in p.krop) && !('booked' in p.krop));
  assert.ok(rb.kald.every(k => k.auth === `Bearer ${SKRIV_NOEGLE}`));
  await ingenHemmeligheder(svar);
});

test('lagerregulering: uden RACKBEAT_SKRIV_KEY skrives intet, heller ikke med læsenøglerne', async () => {
  const rb = falskSkriv();
  const svar = await lagerregulering({ request: regAnmodning(), env: { RACKBEAT_API_KEY: NOEGLE, RACKBEAT_LAGER_KEY: LAGER_NOEGLE } }, deps(rb));
  assert.equal(svar.status, 503);
  assert.equal(rb.kald.length, 0);
});

test('lagerregulering: kald fra en anden side eller uden JSON afvises (CSRF)', async () => {
  for (const opt of [{ origin: 'https://ond.example.com' }, { origin: null }, { type: 'text/plain' }, { type: 'application/x-www-form-urlencoded' }]) {
    const rb = falskSkriv();
    const svar = await lagerregulering({ request: regAnmodning(GYLDIG, opt), env: REG_ENV }, deps(rb));
    assert.equal(svar.status, 403, JSON.stringify(opt));
    assert.equal(rb.kald.length, 0);
  }
});

test('lagerregulering: ugyldige data afvises uden kald til Rackbeat', async () => {
  const forkerte = [
    { ...GYLDIG, antal: 0 }, { ...GYLDIG, antal: -5 }, { ...GYLDIG, antal: 2.5 }, { ...GYLDIG, antal: '63' }, { ...GYLDIG, antal: 10001 },
    { ...GYLDIG, sku: '' }, { ...GYLDIG, sku: '../products' }, { ...GYLDIG, sku: 'HAT003?x=1' }, { ...GYLDIG, batch: 0 },
    { ...GYLDIG, reference: 'kort' }, { ...GYLDIG, reference: 'HAR STORE BOGSTAVER' }, { sku: 'HAT003', antal: 63 }, [GYLDIG], '{ups',
  ];
  for (const k of forkerte) {
    const rb = falskSkriv();
    const svar = await lagerregulering({ request: regAnmodning(k), env: REG_ENV }, deps(rb));
    assert.equal(svar.status, 400, JSON.stringify(k));
    assert.equal(rb.kald.length, 0);
  }
});

test('lagerregulering: en batch, der allerede er registreret, sendes ikke igen', async () => {
  const rb = falskSkriv({ eksisterende: [{ id: 999, description: 'Produktionskalender, ref. b43-1a2b3c4d' }] });
  const svar = await lagerregulering({ request: regAnmodning(), env: REG_ENV }, deps(rb));
  assert.equal(svar.status, 200);
  const b = await krop(svar);
  assert.equal(b.data.id, 999); assert.equal(b.data.allerede, true);
  assert.equal(poster(rb.kald).length, 0);
});

test('lagerregulering: afvisning fra Rackbeat giver fejl uden genforsøg og uden nøgle i svaret', async () => {
  for (const [postStatus, kode] of [[422, 'afvist_af_rackbeat'], [403, 'mangler_adgang'], [429, 'for_mange_kald'], [500, 'rackbeat_fejl']]) {
    const rb = falskSkriv({ postStatus });
    const svar = await lagerregulering({ request: regAnmodning(), env: REG_ENV }, deps(rb));
    assert.equal(svar.status, 502);
    assert.equal((await krop(svar)).kode, kode);
    assert.equal(poster(rb.kald).length, 1, 'et POST må aldrig sendes to gange');
    await ingenHemmeligheder(svar);
  }
});

test('lagerregulering: netværksfejl giver fejl uden POST', async () => {
  const rb = falskSkriv({ netvaerk: true });
  const svar = await lagerregulering({ request: regAnmodning(), env: REG_ENV }, deps(rb));
  assert.equal(svar.status, 502);
  assert.equal((await krop(svar)).kode, 'ingen_forbindelse');
  assert.equal(poster(rb.kald).length, 0);
});

test('ruter: POST /api/lagerregulering bruger Rackbeats adresse og skrivenøglen fra miljøet', async () => {
  const kald = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    kald.push({ url: String(url), metode: init.method, auth: init.headers && init.headers.Authorization });
    return init.method === 'POST' ? new Response(JSON.stringify({ inventory_regulation: { id: 1 } }), { status: 201 })
      : new Response(JSON.stringify({ inventory_regulations: [] }), { status: 206 });
  };
  try {
    const svar = await medMiljoe({ VERCEL: '1', RACKBEAT_SKRIV_KEY: SKRIV_NOEGLE, RACKBEAT_BASE_URL: 'http://127.0.0.1:8790' },
      () => reguleringRute.POST(regAnmodning()));
    assert.equal(svar.status, 201);
  } finally { globalThis.fetch = original; }
  assert.ok(kald.length === 2 && kald.every(k => k.auth === `Bearer ${SKRIV_NOEGLE}` && k.url.startsWith('https://app.rackbeat.com/api/inventory-adjustments')));
});
