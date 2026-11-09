// Tester "Marker som pakket" med lagerregulering i Rackbeat, hele vejen: V2 i browser → tests/dev_server.mjs
// (de rigtige handlers i api/) → tests/mock_rackbeat.js. Kun mock og falsk nøgle, aldrig den rigtige Rackbeat.
// Kørsel: node tests/pak_rackbeat.js
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const MOCK_PORT = 8791, DEV_PORT = 8789;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`, BASE = `http://127.0.0.1:${DEV_PORT}`;
const V2 = '/v2/produktionskalender-v2.html';
const NOEGLE = 'lokal-test';

let failed = false;
const check = (name, ok, info) => { console.log(ok ? 'OK   ' : 'FEJL ', name, ok ? '' : (info ?? '')); if (!ok) failed = true; };
const vent = ms => new Promise(r => setTimeout(r, ms));
async function ventPaa(fn, ms = 8000) {
  for (const slut = Date.now() + ms; Date.now() < slut; await vent(50)) { try { if (await fn()) return true; } catch { /* prøv igen */ } }
  return false;
}

// Mocken og den lokale server får kun falske nøgler. Tomme værdier forhindrer, at .env's rigtige nøgle læses.
const ENV = { ...process.env, RACKBEAT_API_KEY: NOEGLE,
  RACKBEAT_BASE_URL: MOCK, MOCK_NOEGLE: NOEGLE, MOCK_LAGER_STATUS: '' };
delete ENV.VERCEL;
const start = (fil, port) => spawn(process.execPath, [path.join(__dirname, fil), String(port)], { env: ENV, stdio: 'ignore' });

const mock = async (sti, init) => (await fetch(MOCK + sti, { ...init, headers: { Authorization: `Bearer ${NOEGLE}`, ...(init && init.headers) } })).json();
const lagerI = async sku => (await mock('/products?limit=1000&page=1')).products.find(p => p.number === sku).stock_quantity;
const reguleringer = async () => (await mock('/inventory-adjustments?limit=100&page=1')).inventory_regulations;

(async () => {
  const boerne = [start('mock_rackbeat.js', MOCK_PORT), start('dev_server.mjs', DEV_PORT)];
  const b = await chromium.launch();
  try {
    check('servere startet', await ventPaa(async () => (await fetch(BASE + V2)).ok && (await fetch(MOCK + '/products', { headers: { Authorization: `Bearer ${NOEGLE}` } })).ok));
    const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(e.message));
    await p.goto(BASE + V2);
    check('forbundet til Rackbeat', await ventPaa(() => p.$eval('#rbPill', el => el.textContent.startsWith('Rackbeat: opdateret'))), await p.$eval('#rbPill', el => el.textContent));

    const dag = n => { const d = new Date(Date.now() + n * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    await p.evaluate(([k, d3, d1]) => {
      const s = JSON.parse(localStorage.getItem(k));
      s.people = ['Test']; s.nextNo = 42;
      s.batches = [
        { no: 32, by: 'Test', pid: 'tang-shampoo', qty: 55, rejected: 2, made: d3, cure: 3, status: 'aktiv' },
        { no: 41, by: 'Test', pid: 'havtorn-balsam', qty: 50, made: d1, cure: 1, status: 'aktiv' },
      ];
      localStorage.setItem(k, JSON.stringify(s));
    }, ['kystnaer-produktionskalender-v2-onepager-j', dag(-3), dag(-1)]);
    await p.reload();
    await ventPaa(() => p.$eval('#rbPill', el => el.textContent.startsWith('Rackbeat: opdateret')));
    const batch = no => p.evaluate(n => JSON.parse(localStorage.getItem('kystnaer-produktionskalender-v2-onepager-j')).batches.find(x => x.no === n), no);
    const dlg = () => p.$eval('#detailBody', el => el.textContent.replace(/\s+/g, ' '));
    const klik = sel => p.evaluate(s => document.querySelector(s).click(), sel);

    // Batch #32: Tang shampoo bar (TAN001), 55 lavet, 2 kasseret, klar til pakning i dag
    const foer = await lagerI('TAN001');
    await klik('[data-pack="32"]');
    check('bekræftelse vises', await ventPaa(async () => (await dlg()).includes('Læg 53 stk. på Hovedlager i Rackbeat')), await dlg());
    await p.click('#rbNo');
    check('annullér: intet sendt', (await lagerI('TAN001')) === foer && (await reguleringer()).length === 0);
    check('annullér: ikke pakket', !(await batch(32)).packed);

    await klik('[data-pack="32"]');
    await p.waitForSelector('#rbYes');
    await p.click('#rbYes');
    check('dialogen lukker efter svar', await ventPaa(() => p.$eval('#dlgDetail', d => !d.open)));
    const b32 = await batch(32);
    check('batch er pakket med Rackbeat-id', b32.packed && b32.rackbeat && b32.rackbeat.id != null && b32.rackbeat.antal === 53, JSON.stringify(b32));
    check('lageret i Rackbeat er steget med 53', (await lagerI('TAN001')) === foer + 53, `${foer} → ${await lagerI('TAN001')}`);
    const [r] = await reguleringer();
    check('reguleringen er bogført, lægger til og ligger på Hovedlager i Produktion', r && r.is_booked === true && r.regulate_difference === false && r.lines[0].location_id === 1001
      && r.regulation_type.number === 1004 && r.reason === 'Batch #32 godkendt' && r.description.includes(b32.rbRef), JSON.stringify(r));
    // Lageret hentes straks uden om serverens cache, så det nye tal skal vises længe før næste opdatering (20 sek.)
    check('kalenderen viser det nye lager med det samme (under 5 sek.)', await ventPaa(() => p.evaluate(n => JSON.parse(localStorage.getItem('kystnaer-produktionskalender-v2-onepager-j')).products.find(x => x.sku === 'TAN001').count === n
      && document.getElementById('lager-tang-shampoo').textContent.trim() === String(n), foer + 53), 5000),
      await p.evaluate(() => document.getElementById('lager-tang-shampoo') && document.getElementById('lager-tang-shampoo').textContent));

    // Samme batch sendt igen (fx efter netværksfejl) registreres ikke to gange
    const igen = await p.evaluate(async ref => (await fetch('/api/lagerregulering', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: 'TAN001', antal: 53, batch: 32, reference: ref }) })).json(), b32.rbRef);
    check('gentaget kald registreres ikke igen', igen.data.allerede === true && (await reguleringer()).length === 1 && (await lagerI('TAN001')) === foer + 53);

    await klik('[data-batch="32"]');
    await p.waitForSelector('#dClose');
    check('kan ikke fortrydes i kalenderen', !(await p.$('#dUnpack')) && (await dlg()).includes('lagt på Hovedlager'), await dlg());
    await p.click('#dClose');

    // Rackbeat afviser (ukendt varenummer): fejl vises, og batchen er ikke pakket
    await p.evaluate(() => { const k = 'kystnaer-produktionskalender-v2-onepager-j'; const s = JSON.parse(localStorage.getItem(k));
      s.products.find(x => x.id === 'havtorn-balsam').sku = 'FINDES-IKKE'; localStorage.setItem(k, JSON.stringify(s)); });
    await p.reload();
    await ventPaa(() => p.$eval('#rbPill', el => el.textContent.startsWith('Rackbeat: opdateret')));
    await klik('[data-pack="41"]');
    await p.waitForSelector('#rbYes');
    await p.click('#rbYes');
    check('afvisning vises', await ventPaa(() => p.$eval('#rbErr', el => !el.hidden && el.textContent.includes('afviste'))), await p.$eval('#rbErr', el => el.textContent));
    check('afvist batch er ikke pakket', !(await batch(41)).packed && (await reguleringer()).length === 1);
    check('knappen hedder nu Prøv igen', (await p.$eval('#rbYes', el => el.textContent)) === 'Prøv igen');
    await p.click('#rbNo');

    // Uden server (åbnet som fil) pakkes kun i kalenderen, uden dialog
    const f = await (await b.newContext()).newPage();
    const fil = 'file://' + path.resolve(__dirname, '..', 'src', 'v2', 'produktionskalender-v2.html');
    await f.goto(fil);
    await f.evaluate(([k, d3, idag]) => localStorage.setItem(k, JSON.stringify({ people: ['Test'], nextNo: 33, res: [],
      products: [{ id: 'tang-shampoo', name: 'Tang shampoo bar', type: 'Shampoobarer', min: 30, rate: 0, count: 0, countDate: idag, batch: 55, sku: 'TAN001', cure: 3, steps: [] }],
      batches: [{ no: 32, by: 'Test', pid: 'tang-shampoo', qty: 55, rejected: 2, made: d3, cure: 3, status: 'aktiv' }] })), ['kystnaer-produktionskalender-v2-onepager-j', dag(-3), dag(0)]);
    await f.reload();
    await f.evaluate(() => document.querySelector('[data-pack="32"]').click());
    const lokal = await f.evaluate(() => JSON.parse(localStorage.getItem('kystnaer-produktionskalender-v2-onepager-j')).batches.find(x => x.no === 32));
    check('uden server: pakket lokalt uden Rackbeat', lokal.packed && !lokal.rackbeat);

    check('ingen JavaScript-fejl', errs.length === 0, errs.join('; '));
  } finally {
    await b.close();
    boerne.forEach(c => c.kill());
  }
  process.exit(failed ? 1 : 0);
})();
