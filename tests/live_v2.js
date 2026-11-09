// Tester Rackbeat live i V2 mod en lokal server, der efterligner /api. Kørsel: node tests/live_v2.js
// Playwrights ur styres, så 20 sekunder og 10 minutter kan spoles frem uden at vente.
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const V2 = '/v2/produktionskalender-v2.html';
const KEY = 'kystnaer-produktionskalender-v2-onepager-i';
// Uret starter på det rigtige tidspunkt, så testserverens "hentet" og sidens dato er samme dag
const START = new Date();

let failed = false;
const check = (name, ok, info) => { console.log(ok ? 'OK   ' : 'FEJL ', name, ok ? '' : (info ?? '')); if (!ok) failed = true; };

// ---------- testserver ----------
const api = { status: null, salgstempo: null, ingenApi: false };
const hits = { status: 0, salgstempo: 0 };
const ok = (data, extra) => ({ code: 200, body: { data, hentet: new Date().toISOString(), forældet: false, kilde: 'rackbeat', ...extra } });
const LAGER = { HAT003: 62, TAN001: 100, HAT001: 50 };
const statusOk = (lager = LAGER, extra) => ok({ lager, lagerStatus: 'ok', salg: {}, salgFra: '2026-10-28', salgTil: '2026-11-03' }, extra);
const TEMPO = { HAT003: { rate: 12.345, maanedlig: Array(12).fill(12), seneste8: 13, beregnet: '2026-11-03', vindue_uger: 52, sikkerhed: 'høj', flag: ['muligt_udsolgt'] } };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    const navn = url.pathname.slice(5);
    if (api.ingenApi || !(navn in hits)) { res.writeHead(404); return res.end('Not found'); }
    hits[navn]++;
    const svar = typeof api[navn] === 'function' ? api[navn]() : api[navn];
    if (svar.redirect) { res.writeHead(302, { Location: svar.redirect }); return res.end(); }
    res.writeHead(svar.code, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(svar.body));
  }
  const fil = path.join(__dirname, '..', 'src', path.normalize(url.pathname));
  if (!fil.startsWith(path.join(__dirname, '..', 'src')) || !fs.existsSync(fil)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(fil).pipe(res);
});

const vent = ms => new Promise(r => setTimeout(r, ms));
async function ventPaa(fn, ms = 3000) {
  for (const slut = Date.now() + ms; Date.now() < slut; await vent(25)) if (await fn()) return true;
  return false;
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const b = await chromium.launch();

  async function aaben({ synlig = true } = {}) {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(e.message));
    // Fanens synlighed styres fra testen
    await p.addInitScript(s => {
      window.__synlig = s;
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window.__synlig ? 'visible' : 'hidden') });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => !window.__synlig });
    }, synlig);
    await p.clock.install({ time: START });
    hits.status = hits.salgstempo = 0;
    await p.goto(BASE + V2);
    await p.evaluate(() => { document.getElementById('sec-produkter').open = true; });
    return { p, ctx, errs };
  }
  const synlig = (p, s) => p.evaluate(s => { window.__synlig = s; document.dispatchEvent(new Event('visibilitychange')); }, s);
  const pill = p => p.$eval('#rbPill', el => ({ text: el.textContent, cls: [...el.classList].filter(c => c !== 'rb-pill').join(' ') }));
  const lager = (p, id) => p.$eval('#lager-' + id, el => el.textContent);
  const state = p => p.evaluate(k => JSON.parse(localStorage.getItem(k)), KEY);
  const prodText = p => p.$eval('#p-produkter', el => el.textContent);
  const spol = async (p, ms) => { await p.clock.runFor(ms); await vent(60); };
  const naarHits = (navn, n) => ventPaa(() => hits[navn] >= n);

  // ---------- start: henter straks og opdaterer lager og salgstempo ----------
  api.status = () => statusOk(); api.salgstempo = () => ok(TEMPO);
  let { p, ctx, errs } = await aaben();
  await naarHits('status', 1); await naarHits('salgstempo', 1);
  await ventPaa(async () => (await pill(p)).cls === 'ok');
  let s = await pill(p);
  check('start: status og salgstempo hentes straks', hits.status === 1 && hits.salgstempo === 1, JSON.stringify(hits));
  check('pillen er grøn med tidspunkt', s.cls === 'ok' && /^Rackbeat: opdateret \d\d:\d\d:\d\d$/.test(s.text), JSON.stringify(s));
  check('lager fra Rackbeat vises', await lager(p, 'havtorn-saebe') === '62');
  const txt = await prodText(p);
  check('kilde pr. produkt: Rackbeat, hh:mm:ss', /Rackbeat, \d\d:\d\d:\d\d/.test(txt));
  check('produkt uden data viser Estimat', (await p.$eval('#lager-lanolin-saebe', el => el.parentElement.textContent)).includes('Estimat'));
  check('salgstempo sat og fuld præcision gemt', (await state(p)).products.find(x => x.sku === 'HAT003').rate === 12.345);
  check('salgstempo vises med kilde og flag', /Rackbeat, \d\d:\d\d:\d\d\s*Sikkerhed: høj\s*muligt udsolgt/.test(txt), txt.slice(0, 400));
  const foer = await state(p);

  // ---------- polling hvert 20. sekund ----------
  await spol(p, 19000);
  check('intet nyt kald før 20 sekunder', hits.status === 1);
  await spol(p, 1000); await naarHits('status', 2);
  check('nyt kald efter 20 sekunder', hits.status === 2);
  check('salgstempo hentes ikke hvert 20. sekund', hits.salgstempo === 1);

  // ---------- batches, reservationer og indstillinger røres ikke ----------
  api.status = () => statusOk({ ...LAGER, HAT003: 70 });
  await spol(p, 20000); await naarHits('status', 3);
  await ventPaa(async () => await lager(p, 'havtorn-saebe') === '70');
  const efter = await state(p);
  check('lager opdateres ved næste kald', await lager(p, 'havtorn-saebe') === '70');
  check('batches og reservationer urørt', JSON.stringify(efter.batches) === JSON.stringify(foer.batches) && JSON.stringify(efter.res) === JSON.stringify(foer.res));
  check('indstillinger urørt', efter.products.every((x, i) => ['min', 'cure', 'batch', 'steps', 'name', 'type'].every(k => JSON.stringify(x[k]) === JSON.stringify(foer.products[i][k]))));

  // ---------- skjult fane: ingen kald, straks igen ved synlig ----------
  const n0 = hits.status;
  await synlig(p, false);
  await spol(p, 120000);
  check('ingen kald, mens fanen er skjult', hits.status === n0, `${hits.status} vs ${n0}`);
  await synlig(p, true);
  check('hentes straks, når fanen bliver synlig', await naarHits('status', n0 + 1));
  await spol(p, 20000);
  check('polling genoptages', await naarHits('status', n0 + 2));

  // ---------- salgstempo hvert 10. minut ----------
  const t0 = hits.salgstempo;
  await spol(p, 10 * 60000);
  check('salgstempo hentes igen efter 10 minutter', await naarHits('salgstempo', t0 + 1), JSON.stringify(hits));

  // ---------- backoff ved fejl: 20 → 40 → 60, og tilbage ved succes ----------
  api.status = () => ({ code: 502, body: { data: null, hentet: null, forældet: true, kilde: 'rackbeat', fejl: 'Rackbeat svarer ikke', kode: 'rackbeat_fejl' } });
  await spol(p, 60000); await vent(100);   // næste planlagte kald fejler
  let n = hits.status;
  await ventPaa(async () => (await pill(p)).cls === 'err');
  s = await pill(p);
  check('fejl: rød pille', s.cls === 'err' && s.text === 'Rackbeat: fejl', JSON.stringify(s));
  check('appen beholder sine data ved fejl', await lager(p, 'havtorn-saebe') === '70');
  // Første fejl er sket. Næste kald først efter 40 sek., derefter 60 sek.
  const fejlFoer = (await p.evaluate(() => document.getElementById('syncLog').textContent));
  await spol(p, 39000);
  const efter39 = hits.status;
  await spol(p, 1000); await naarHits('status', efter39 + 1);
  const efter40 = hits.status;
  await spol(p, 59000);
  const efter99 = hits.status;
  await spol(p, 1000); await naarHits('status', efter99 + 1);
  check('backoff: 40 sek. efter første fejl', efter39 === n && efter40 === n + 1, `${n} ${efter39} ${efter40} (${fejlFoer})`);
  check('backoff: 60 sek. efter anden fejl', efter99 === efter40 && hits.status === efter40 + 1, `${efter40} ${efter99} ${hits.status}`);
  await spol(p, 59000);
  check('backoff: højst 60 sek.', hits.status === efter40 + 1);
  api.status = () => statusOk();
  await spol(p, 1000); await naarHits('status', efter40 + 2);
  await ventPaa(async () => (await pill(p)).cls === 'ok');
  const efterOk = hits.status;
  await spol(p, 20000); await naarHits('status', efterOk + 1);
  check('tilbage til 20 sek. efter succes', hits.status === efterOk + 1 && (await pill(p)).cls === 'ok');

  // ---------- forældet, mangler adgang, login ----------
  api.status = () => statusOk(LAGER, { forældet: true, hentet: new Date(Date.now() - 300000).toISOString() });
  await spol(p, 20000); await ventPaa(async () => (await pill(p)).cls === 'stale');
  s = await pill(p);
  check('forældet: gul pille', s.cls === 'stale' && /^Rackbeat: forældet \(\d\d:\d\d:\d\d\)$/.test(s.text), JSON.stringify(s));

  api.status = () => ok({ lager: null, lagerStatus: 'mangler_adgang', salg: {} });
  const lagerFoer = await lager(p, 'havtorn-saebe');
  await spol(p, 20000); await ventPaa(async () => (await pill(p)).text.includes('mangler adgang'));
  s = await pill(p);
  check('mangler adgang til lager: rød pille', s.cls === 'err' && s.text === 'Rackbeat: mangler adgang til lager', JSON.stringify(s));
  check('mangler adgang: lageret beholdes', await lager(p, 'havtorn-saebe') === lagerFoer);

  api.status = () => ({ redirect: 'https://kystnaer.cloudflareaccess.com/cdn-cgi/access/login' });
  await spol(p, 20000); await ventPaa(async () => (await pill(p)).text.includes('log ind'));
  s = await pill(p);
  check('udløbet login: rød pille', s.cls === 'err' && s.text === 'Rackbeat: log ind igen', JSON.stringify(s));
  api.status = () => ({ code: 403, body: { fejl: 'Ingen adgang' } });
  await spol(p, 40000); await ventPaa(async () => (await pill(p)).text.includes('log ind'));
  check('afvist af Access (403): rød pille', (await pill(p)).text === 'Rackbeat: log ind igen');
  check('ingen JavaScript-fejl (polling)', errs.length === 0, errs.join('; '));
  await ctx.close();

  // ---------- ingen overskrivning, mens en dialog er åben ----------
  api.status = () => statusOk(); api.salgstempo = () => ok(TEMPO);
  ({ p, ctx, errs } = await aaben());
  await naarHits('status', 1); await ventPaa(async () => await lager(p, 'havtorn-saebe') === '62');
  api.status = () => statusOk({ ...LAGER, HAT003: 99 });
  await p.click('#btnNewBatch');
  check('dialog åben', await p.$('dialog[open]') !== null);
  await spol(p, 20000); await naarHits('status', 2); await vent(200);
  check('dialog: kaldet sker stadig', hits.status === 2);
  check('dialog: lageret i appen er ikke overskrevet', (await state(p)).products.find(x => x.sku === 'HAT003').count === 62);
  check('dialog: visningen er ikke ændret', await lager(p, 'havtorn-saebe') === '62');
  await p.keyboard.press('Escape');
  check('opdateres, når dialogen lukkes', await ventPaa(async () => await lager(p, 'havtorn-saebe') === '99'));

  // ---------- ingen overskrivning, mens man skriver i et felt ----------
  api.status = () => statusOk({ ...LAGER, HAT003: 111 });
  await p.click('#min-havtorn-saebe');
  await p.keyboard.press('ControlOrMeta+A');
  await p.keyboard.type('505');
  await spol(p, 20000); await naarHits('status', 3); await vent(200);
  check('felt med ændring: ikke overskrevet', await lager(p, 'havtorn-saebe') === '99');
  check('felt med ændring: det indtastede bevares', await p.$eval('#min-havtorn-saebe', el => el.value) === '505', await p.$eval('#min-havtorn-saebe', el => el.value));
  await p.keyboard.press('Tab');
  check('opdateres, når feltet forlades', await ventPaa(async () => await lager(p, 'havtorn-saebe') === '111'));
  check('det indtastede minimum er gemt', (await state(p)).products.find(x => x.sku === 'HAT003').min === 505);

  // Fokus i et felt uden ændring blokerer ikke, og fokus bevares efter opdateringen
  api.status = () => statusOk({ ...LAGER, HAT003: 120 });
  await p.focus('#min-hyben-saebe');
  await spol(p, 20000); await naarHits('status', 4);
  check('fokus uden ændring: opdateres alligevel', await ventPaa(async () => await lager(p, 'havtorn-saebe') === '120'));
  check('fokus bevares efter opdatering', await p.evaluate(() => document.activeElement && document.activeElement.id) === 'min-hyben-saebe');
  check('ingen JavaScript-fejl (dialog)', errs.length === 0, errs.join('; '));
  await ctx.close();

  // ---------- dobbelttælling: pakkede batches er med i Rackbeats lager ----------
  api.status = () => statusOk(); api.salgstempo = () => ok({});
  ({ p, ctx, errs } = await aaben());
  await naarHits('status', 1); await ventPaa(async () => await lager(p, 'tang-shampoo') === '100');
  await p.evaluate(k => {
    const d = JSON.parse(localStorage.getItem(k));
    d.batches.find(b => b.no === 36).packed = true;   // Havtorn shampoo, klar om 5 dage, men allerede pakket
    localStorage.setItem(k, JSON.stringify(d));
  }, KEY);
  await p.reload(); await p.evaluate(() => { document.getElementById('sec-produkter').open = true; });
  await ventPaa(async () => await lager(p, 'havtorn-shampoo') === '50');
  const naarKlar = id => p.$eval('#lager-' + id, el => el.closest('tr').children[6].textContent.trim());
  // Tang shampoo: 100 + batch 32 (klar i dag, ikke pakket, 55 − 2 kasseret) − 9/uge × 3 dage = 149
  check('upakket batch, der er klar, lægges til Rackbeats lager', await naarKlar('tang-shampoo') === '149', await naarKlar('tang-shampoo'));
  // Havtorn shampoo: 50 − 16/uge × 7 dage = 34. Det pakkede batch (60 stk.) må ikke tælles igen.
  check('pakket batch tælles ikke to gange', await naarKlar('havtorn-shampoo') === '34', await naarKlar('havtorn-shampoo'));
  check('ingen JavaScript-fejl (dobbelttælling)', errs.length === 0, errs.join('; '));
  await ctx.close();

  // ---------- uden server: eksempeldata, ingen polling ----------
  api.ingenApi = true;
  ({ p, ctx, errs } = await aaben());
  await vent(300);
  s = await pill(p);
  check('uden /api: ikke forbundet', s.text === 'Rackbeat: ikke forbundet' && s.cls === '', JSON.stringify(s));
  const k = hits.status;
  await spol(p, 120000);
  check('uden /api: ingen videre kald', hits.status === k);
  check('uden /api: filimport findes stadig', await p.$('#btnImport') !== null && await p.$('#btnSync') !== null);
  check('ingen JavaScript-fejl (uden server)', errs.length === 0, errs.join('; '));
  await ctx.close();

  await b.close();
  server.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
