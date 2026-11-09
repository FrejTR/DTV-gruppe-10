// Test af serverfunktionerne mod en falsk Rackbeat. Ingen rigtig nøgle. Kørsel: node --test tests/
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as middleware } from '../functions/api/_middleware.js';
import { onRequestGet as statusGet } from '../functions/api/status.js';
import { onRequestGet as salgstempoGet } from '../functions/api/salgstempo.js';
import { status, salgstempo, STATUS_TTL_MS, SALGSTEMPO_TTL_MS } from '../functions/_lib/endpoints.js';
import { _nulstil as nulstilCache } from '../functions/_lib/cache.js';
import { _nulstil as nulstilAccess, verificerToken } from '../functions/_lib/access.js';

const NOEGLE = 'hemmelig-test-noegle-123';
const LAGER_NOEGLE = 'hemmelig-lager-noegle-456';
const TEAM = 'https://kystnaer.cloudflareaccess.com';
const AUD = 'aud-tag-123';
const ENV = { RACKBEAT_API_KEY: NOEGLE, CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD };
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
  nulstilCache(); nulstilAccess(); ur = NU; logs = [];
  console.error = (...a) => logs.push(a.join(' '));
});
afterEach(() => { console.error = originalError; delete globalThis.caches; });

const krop = async svar => JSON.parse(await svar.clone().text());
async function ingenHemmeligheder(svar) {
  const tekst = await svar.clone().text();
  for (const s of [NOEGLE, LAGER_NOEGLE, 'Hemmelig Kunde', 'Bearer']) {
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

test('status: Cache API deles mellem isolater i samme datacenter', async () => {
  const lager = new Map();
  globalThis.caches = { default: {
    match: async u => lager.has(String(u)) ? new Response(lager.get(String(u))) : undefined,
    put: async (u, r) => { lager.set(String(u), await r.text()); },
  } };
  const rb = falskRackbeat();
  await status(ctx(), deps(rb));
  nulstilCache();   // nyt isolat: tom hukommelse
  const foer = rb.kald.length;
  await status(ctx(), deps(rb));
  assert.equal(rb.kald.length, foer);
  assert.ok([...lager.keys()].every(k => k.startsWith('https://kalender.example.com/api/__cache/')));
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
  const svar = await salgstempo(ctx(), deps(falskRackbeat({ order_lines: sider })));
  assert.equal(svar.status, 502);
  assert.equal((await krop(svar)).kode, 'for_mange_sider');
  nulstilCache();
  const hoejere = await salgstempo(ctx({ ...ENV, SALGSTEMPO_MAX_SIDER: '60' }), deps(falskRackbeat({ order_lines: sider })));
  assert.equal(hoejere.status, 200, 'grænsen kan hæves på Workers Paid');
});

test('salgstempo: manglende nøgle giver 503 og 429 uden gemt version giver 502', async () => {
  assert.equal((await salgstempo(ctx({ ...ENV, RACKBEAT_API_KEY: undefined }), deps(falskRackbeat()))).status, 503);
  const svar = await salgstempo(ctx(), deps(falskRackbeat({ order_linesStatus: 429 })));
  assert.equal(svar.status, 502);
  await ingenHemmeligheder(svar);
});

// ---------- Cloudflare Access ----------
const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
async function noeglepar(kid) {
  const par = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  return { kid, privat: par.privateKey, jwk: { ...(await crypto.subtle.exportKey('jwk', par.publicKey)), kid, alg: 'RS256', use: 'sig' } };
}
async function token(par, krop = {}, hoved = {}) {
  const sek = Math.floor(Date.now() / 1000);
  const del = `${enc({ alg: 'RS256', kid: par.kid, typ: 'JWT', ...hoved })}.${enc({ iss: TEAM, aud: [AUD], exp: sek + 600, iat: sek, sub: 'u', ...krop })}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', par.privat, new TextEncoder().encode(del));
  return `${del}.${Buffer.from(sig).toString('base64url')}`;
}

const PAR = await noeglepar('k1');
const ANDET = await noeglepar('k2');
let certsKald;
function medCerts(noegler) {
  certsKald = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, `${TEAM}/cdn-cgi/access/certs`);
    certsKald++;
    return new Response(JSON.stringify({ keys: noegler.map(p => p.jwk), public_certs: [] }));
  };
  return () => { globalThis.fetch = original; };
}
async function gennemMiddleware({ jwt, env = ENV, url = URL_PROD }) {
  const headers = jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {};
  let videre = false;
  const svar = await middleware({ request: new Request(url, { headers }), env, next: async () => { videre = true; return new Response('ok'); } });
  return { svar, videre };
}

test('access: afviser kald uden token', async () => {
  const slut = medCerts([PAR]);
  try {
    const { svar, videre } = await gennemMiddleware({});
    assert.equal(svar.status, 403); assert.equal(videre, false);
  } finally { slut(); }
});

test('access: gyldigt token slipper igennem', async () => {
  const slut = medCerts([PAR]);
  try {
    const { svar, videre } = await gennemMiddleware({ jwt: await token(PAR) });
    assert.equal(videre, true); assert.equal(await svar.text(), 'ok');
  } finally { slut(); }
});

for (const [navn, lav] of [
  ['forkert signatur', async () => (await token(PAR)).slice(0, -6) + 'AAAAAA'],
  ['signeret med ukendt nøgle', () => token(ANDET)],
  ['forkert audience', () => token(PAR, { aud: ['andet'] })],
  ['forkert udsteder', () => token(PAR, { iss: 'https://ondt.cloudflareaccess.com' })],
  ['udløbet', () => token(PAR, { exp: Math.floor(Date.now() / 1000) - 3600 })],
  ['ikke gyldigt endnu', () => token(PAR, { nbf: Math.floor(Date.now() / 1000) + 3600 })],
  ['alg none', async () => { const t = (await token(PAR, {}, { alg: 'none' })).split('.'); return `${t[0]}.${t[1]}.`; }],
  ['HS256', () => token(PAR, {}, { alg: 'HS256' })],
  ['ikke et JWT', async () => 'abc.def'],
  ['skrald', async () => '...'],
]) {
  test(`access: afviser ${navn}`, async () => {
    const slut = medCerts([PAR]);
    try {
      const { svar, videre } = await gennemMiddleware({ jwt: await lav() });
      assert.equal(svar.status, 403); assert.equal(videre, false);
    } finally { slut(); }
  });
}

test('access: nye nøgler hentes ved ukendt kid (rotation), højst én gang i minuttet', async () => {
  let slut = medCerts([PAR]);
  await gennemMiddleware({ jwt: await token(PAR) });
  slut();
  slut = medCerts([PAR, ANDET]);
  try {
    const { videre } = await gennemMiddleware({ jwt: await token(ANDET) });
    assert.equal(videre, true);
    assert.equal(certsKald, 1);
  } finally { slut(); }
  // En tredje ukendt nøgle inden for samme minut giver ikke et nyt opslag
  const TREDJE = await noeglepar('k3');
  slut = medCerts([PAR, ANDET, TREDJE]);
  try {
    assert.equal((await gennemMiddleware({ jwt: await token(TREDJE) })).videre, false);
    assert.equal(certsKald, 0);
  } finally { slut(); }
});

test('access: manglende opsætning afviser (503), aldrig åbent', async () => {
  for (const env of [{ ...ENV, CF_ACCESS_AUD: '' }, { ...ENV, CF_ACCESS_TEAM_DOMAIN: undefined }]) {
    const { svar, videre } = await gennemMiddleware({ jwt: 'x.y.z', env });
    assert.equal(svar.status, 503); assert.equal(videre, false);
  }
});

test('access: utilgængelige nøgler afviser', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('nej', { status: 500 });
  try {
    const { svar, videre } = await gennemMiddleware({ jwt: await token(PAR) });
    assert.equal(svar.status, 503); assert.equal(videre, false);
  } finally { globalThis.fetch = original; }
});

test('access: lokal udvikling kræver både variabel og lokal adresse', async () => {
  const lokal = { ...ENV, LOKAL_UDVIKLING_UDEN_ACCESS: 'ja' };
  assert.equal((await gennemMiddleware({ env: lokal, url: 'http://localhost:8788/api/status' })).videre, true);
  assert.equal((await gennemMiddleware({ env: lokal, url: 'http://127.0.0.1:8788/api/status' })).videre, true);
  const slut = medCerts([PAR]);
  try {
    assert.equal((await gennemMiddleware({ env: lokal, url: URL_PROD })).videre, false, 'ikke i produktion');
    assert.equal((await gennemMiddleware({ env: { ...ENV, LOKAL_UDVIKLING_UDEN_ACCESS: 'true' }, url: 'http://localhost:8788/api/status' })).videre, false, 'kun præcis "ja"');
    assert.equal((await gennemMiddleware({ env: ENV, url: 'http://localhost:8788/api/status' })).videre, false, 'ikke som standard');
  } finally { slut(); }
});

test('access: verificerToken tjekker audience som streng og liste', async () => {
  const slut = medCerts([PAR]);
  try {
    assert.equal(await verificerToken(await token(PAR, { aud: AUD }), { team: TEAM, aud: AUD }), true);
  } finally { slut(); }
});

// ---------- routing ----------
test('routes: RACKBEAT_BASE_URL bruges kun i lokal udvikling', async () => {
  const kald = [];
  const original = globalThis.fetch;
  globalThis.fetch = async url => { kald.push(String(url)); return side('order_lines', [], 1, 0); };
  try {
    await statusGet({ request: new Request(URL_PROD), env: { ...ENV, RACKBEAT_BASE_URL: 'http://mock.local', LOKAL_UDVIKLING_UDEN_ACCESS: 'ja' }, waitUntil() {} });
    assert.ok(kald.length && kald.every(u => u.startsWith('https://app.rackbeat.com/api/')), kald.join());
    nulstilCache(); kald.length = 0;
    await salgstempoGet({ request: new Request('http://localhost:8788/api/salgstempo'), env: { ...ENV, RACKBEAT_BASE_URL: 'http://mock.local', LOKAL_UDVIKLING_UDEN_ACCESS: 'ja' }, waitUntil() {} });
    assert.ok(kald.length && kald.every(u => u.startsWith('http://mock.local/')), kald.join());
  } finally { globalThis.fetch = original; }
});
